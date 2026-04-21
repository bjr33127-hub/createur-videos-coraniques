#!/usr/bin/env python3

import argparse
import json
import math
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Dict, List, Optional, Tuple

QURAN_COM_BASE = "https://api.quran.com/api/v4"
GROQ_TRANSCRIPT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
DEFAULT_GROQ_MODEL = os.getenv("PERSONALIZED_GROQ_MODEL", "whisper-large-v3-turbo")
CHUNK_DURATION_SEC = 24.0
CHUNK_STEP_SEC = 20.0
TRACK_WINDOW_WORDS = 180
BACKWARD_MARGIN_WORDS = 84
SEARCH_FALLBACK_WORDS = 420
MIN_SEGMENT_WORDS = 3
MAX_SEGMENT_WORDS = 96
WORD_THRESHOLD = 0.48
TIMING_WORD_THRESHOLD = 0.24
SEGMENT_THRESHOLD = 0.28
LOW_CONFIDENCE_THRESHOLD = 0.30
MIN_COVERAGE_RATIO = 0.32
MIN_AYAH_COVERAGE = 0.50
MIN_LAST_WORD_REACHED = 0.78
RELAXED_MIN_COVERAGE_RATIO = 0.25
RELAXED_MIN_AYAH_RATIO = 0.28
RELAXED_MIN_LAST_WORD_REACHED = 0.82
MIN_WORD_DURATION_SEC = 0.10
WORD_GAP_SEC = 0.02
AYAH_PAD_SEC = 0.05
SYNC_OCCURRENCE_MIN_SIMILARITY = 0.32
SYNC_OCCURRENCE_MERGE_GAP_SEC = 0.18
SYNC_OCCURRENCE_MAX_PER_WORD = 10
DISPLAY_SWITCH_WORDS = 3
DISPLAY_SWITCH_CLUSTER_SEC = 2.4
MAX_DISPLAY_LEAD_SEC = 8.0
MAX_STRONG_DISPLAY_LEAD_SEC = 24.0
MAX_REPEAT_EXTENSION_SEC = 20.0
GLOBAL_SEARCH_TRIGGER_CHUNKS = 2
GLOBAL_SEARCH_STRIDE = 4
GLOBAL_SEARCH_REFINE_WORDS = 24
MIN_ANCHOR_MATCHES = 2
MIN_ANCHOR_RATIO = 0.08
INFERRED_TIMING_SIMILARITY = 0.18
PERSONALIZED_IMPORT_FORMAT_VERSION = 4
INITIAL_MATCH_MAX_START_WORD = 12
INITIAL_MATCH_MIN_SCORE = 0.45
PRELUDE_MATCH_THRESHOLD = 0.6
DEFAULT_AYAH_LEAD_PAD_SEC = 0.035
DEFAULT_AYAH_TAIL_PAD_SEC = 0.320
DETECT_SNIPPET_SEC = 18.0
PREVIEW_SNIPPET_SEC = 12.0
PREVIEW_MAX_SAMPLES = 4
PREVIEW_MIN_SAMPLE_GAP_SEC = 10.0
DETECT_MAX_SAMPLES = 5
DETECT_MIN_SAMPLE_GAP_SEC = 12.0
EARLY_DETECT_SAMPLE_OFFSETS_SEC = (8.0, 16.0)
DETECT_MIN_WORDS = 2
DETECT_MAX_WORDS = 24
DETECT_TOP_CANDIDATES = 5
DETECT_CACHE_VERSION = 2
DETECT_SCORE_MIN = 0.18
DETECT_MARGIN_MIN = 0.01
DETECT_WINDOW_MAX_AYAHS = 3
DETECT_WINDOW_MAX_WORDS = 36
DETECT_INDEX_COMMON_WORD_DOC_FREQ = 260
DETECT_MAX_CANDIDATE_WINDOWS = 180
PRELUDE_SEQUENCES = [
    ["اعوذ", "بالله", "من", "الشيطان", "الرجيم"],
    ["بسم", "الله", "الرحمن", "الرحيم"],
]


def configure_stdio():
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except Exception:
                pass


def emit(event_type: str, **payload):
    message = {"type": event_type, **payload}
    print(json.dumps(message, ensure_ascii=True), flush=True)


configure_stdio()


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json_url(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "QuranVideoMaker-PersonalizedImport/1.0"
        }
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


ARABIC_DIACRITICS_RE = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED]")
NON_ARABIC_RE = re.compile(r"[^\u0621-\u063A\u0641-\u064A\s]")
TAG_RE = re.compile(r"<[^>]+>")


def strip_html(value: str) -> str:
    # Tajweed markup often wraps letters inside a word. Removing tags without
    # inserting spaces keeps the original word boundaries intact.
    text = TAG_RE.sub("", unescape(value or ""))
    return re.sub(r"\s+", " ", text).strip()


def normalize_arabic(value: str) -> str:
    text = strip_html(value)
    text = ARABIC_DIACRITICS_RE.sub("", text)
    text = text.replace("ـ", "")
    text = (
        text.replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ٱ", "ا")
        .replace("ى", "ي")
        .replace("ؤ", "و")
        .replace("ئ", "ي")
        .replace("ة", "ه")
    )
    text = NON_ARABIC_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


# Override mojibake-prone literals with explicit Unicode escapes so Windows
# file/terminal encodings cannot silently corrupt Quranic normalization.
PRELUDE_SEQUENCES = [
    ["\u0627\u0639\u0648\u0630", "\u0628\u0627\u0644\u0644\u0647", "\u0645\u0646", "\u0627\u0644\u0634\u064A\u0637\u0627\u0646", "\u0627\u0644\u0631\u062C\u064A\u0645"],
    ["\u0628\u0633\u0645", "\u0627\u0644\u0644\u0647", "\u0627\u0644\u0631\u062D\u0645\u0646", "\u0627\u0644\u0631\u062D\u064A\u0645"],
]
ZERO_WIDTH_RE = re.compile(r"[\u200C\u200D\uFEFF]")
NON_ARABIC_RE = re.compile(r"[^\u0621-\u063A\u0641-\u064A\u066E-\u066F\u0671-\u06D3\s]")
ARABIC_CHAR_REPLACEMENTS = (
    ("\u0623", "\u0627"),
    ("\u0625", "\u0627"),
    ("\u0622", "\u0627"),
    ("\u0671", "\u0627"),
    ("\u0672", "\u0627"),
    ("\u0673", "\u0627"),
    ("\u0675", "\u0627"),
    ("\u0649", "\u064A"),
    ("\u0624", "\u0648"),
    ("\u0626", "\u064A"),
    ("\u0629", "\u0647"),
)


def normalize_arabic(value: str) -> str:
    text = strip_html(value)
    text = ZERO_WIDTH_RE.sub("", text)
    text = ARABIC_DIACRITICS_RE.sub("", text)
    text = text.replace("\u0640", "")
    for source, target in ARABIC_CHAR_REPLACEMENTS:
        text = text.replace(source, target)
    text = NON_ARABIC_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def pad3(value: int) -> str:
    return f"{int(value):03d}"


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, start=1):
        current = [i]
        for j, char_b in enumerate(b, start=1):
            insert_cost = current[j - 1] + 1
            delete_cost = previous[j] + 1
            replace_cost = previous[j - 1] + (0 if char_a == char_b else 1)
            current.append(min(insert_cost, delete_cost, replace_cost))
        previous = current
    return previous[-1]


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    max_len = max(len(a), len(b), 1)
    return 1.0 - (levenshtein(a, b) / max_len)


def average(values: List[float], fallback: float = 0.0) -> float:
    if not values:
        return fallback
    return sum(values) / len(values)


@dataclass
class QuranWord:
    global_index: int
    ayah: int
    word_index: int
    text: str


@dataclass
class ChunkWord:
    text: str
    start: float
    end: float


def fetch_surah_words(surah: int, start_ayah: int = 1) -> Tuple[List[QuranWord], Dict[int, List[QuranWord]]]:
    page = 1
    words: List[QuranWord] = []
    ayah_map: Dict[int, List[QuranWord]] = {}
    effective_start_ayah = max(1, int(start_ayah or 1))

    while True:
        url = (
            f"{QURAN_COM_BASE}/verses/by_chapter/{surah}"
            f"?fields=text_uthmani_tajweed,verse_key,verse_number&page={page}&per_page=50"
        )
        payload = read_json_url(url)
        verses = payload.get("verses") or []
        for verse in verses:
            ayah_no = int(verse.get("verse_number") or 0)
            if ayah_no < effective_start_ayah:
                continue
            normalized = normalize_arabic(verse.get("text_uthmani_tajweed") or "")
            verse_words = []
            for word_index, word in enumerate(normalized.split(), start=1):
                qword = QuranWord(
                    global_index=len(words),
                    ayah=ayah_no,
                    word_index=word_index,
                    text=word
                )
                words.append(qword)
                verse_words.append(qword)
            ayah_map[ayah_no] = verse_words
        pagination = payload.get("pagination") or {}
        next_page = pagination.get("next_page")
        if not next_page:
            break
        page = int(next_page)

    if not words or not ayah_map:
        raise RuntimeError(
            f"Impossible de charger la sourate depuis Quran.com a partir du verset {effective_start_ayah}."
        )
    return words, ayah_map


def fetch_surah_detection_payload(surah: int) -> dict:
    quran_words, ayah_map = fetch_surah_words(surah)
    ayahs = []
    for ayah_no in sorted(ayah_map):
        words = [word.text for word in ayah_map[ayah_no] if word.text]
        if words:
            ayahs.append({
                "ayah": int(ayah_no),
                "words": words
            })
    if not quran_words or not ayahs:
        raise RuntimeError(f"Impossible de charger la sourate {surah} pour l'auto-detection.")
    return {
        "surah": int(surah),
        "ayahs": ayahs
    }


def load_detection_reference(cache_dir: Optional[Path]) -> List[dict]:
    cache_path = None
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / f"surah_detection_cache_v{DETECT_CACHE_VERSION}.json"

    if cache_path and cache_path.exists():
        try:
            payload = read_json_file(cache_path)
            items = payload.get("surahs") or []
            if len(items) == 114:
                return items
        except Exception:  # pylint: disable=broad-except
            pass

    surahs_by_no: Dict[int, dict] = {}
    completed = 0
    with ThreadPoolExecutor(max_workers=8) as executor:
        future_map = {
            executor.submit(fetch_surah_detection_payload, surah_no): surah_no
            for surah_no in range(1, 115)
        }
        for future in as_completed(future_map):
            surah_no = future_map[future]
            surahs_by_no[surah_no] = future.result()
            completed += 1
            emit(
                "progress",
                stage="detect_reference",
                progress=clamp(0.10 + (completed / 114.0) * 0.28, 0.10, 0.38),
                message=f"Preparation de l'index Coran ({completed}/114)..."
            )

    surahs = [surahs_by_no[number] for number in sorted(surahs_by_no)]
    payload = {
        "version": DETECT_CACHE_VERSION,
        "generatedAt": iso_now(),
        "surahs": surahs
    }
    if cache_path:
        write_json(cache_path, payload)
    return surahs


def build_quran_words_from_plain(words: List[str]) -> List[QuranWord]:
    return [
        QuranWord(
            global_index=index,
            ayah=1,
            word_index=index + 1,
            text=text
        )
        for index, text in enumerate(words)
    ]


def build_detection_windows(reference_surahs: List[dict]) -> Tuple[List[dict], Dict[str, List[int]], Dict[str, int]]:
    windows: List[dict] = []
    for entry in reference_surahs:
        surah_no = int(entry.get("surah") or 0)
        ayahs = list(entry.get("ayahs") or [])
        for start_index, ayah_entry in enumerate(ayahs):
            combined_words: List[str] = []
            for end_index in range(start_index, min(len(ayahs), start_index + DETECT_WINDOW_MAX_AYAHS)):
                next_words = list((ayahs[end_index] or {}).get("words") or [])
                if not next_words:
                    continue
                candidate_words = combined_words + next_words
                if len(candidate_words) > DETECT_WINDOW_MAX_WORDS and combined_words:
                    break
                combined_words = candidate_words
                windows.append({
                    "surah": surah_no,
                    "startAyah": int(ayah_entry.get("ayah") or 0),
                    "endAyah": int((ayahs[end_index] or {}).get("ayah") or 0),
                    "words": list(combined_words)
                })

    doc_freq: Dict[str, int] = Counter()
    for window in windows:
        for word in set(window["words"]):
            doc_freq[word] += 1

    inverted_index: Dict[str, List[int]] = defaultdict(list)
    for index, window in enumerate(windows):
        word_set = set(window["words"])
        window["wordSet"] = word_set
        for word in word_set:
            if doc_freq.get(word, 0) <= DETECT_INDEX_COMMON_WORD_DOC_FREQ:
                inverted_index[word].append(index)
    return windows, dict(inverted_index), dict(doc_freq)


def build_detection_variants(chunk_words: List[ChunkWord]) -> List[Tuple[str, List[str]]]:
    variants: List[Tuple[str, List[str]]] = []
    raw_words = [word.text for word in chunk_words if word.text]
    trimmed_chunk_words, _removed = trim_leading_prelude_words(chunk_words, 0)
    trimmed_words = [word.text for word in trimmed_chunk_words if word.text]

    seen = set()

    def add_variant(label: str, words: List[str]) -> None:
        normalized = [word for word in words if word]
        if len(normalized) < DETECT_MIN_WORDS:
            return
        max_take = min(len(normalized), DETECT_MAX_WORDS)
        lengths = []
        for candidate_len in [max_take, min(max_take, 18), min(max_take, 14), min(max_take, 10), min(max_take, 6), min(max_take, 4), min(max_take, 3), min(max_take, 2)]:
            if candidate_len >= DETECT_MIN_WORDS and candidate_len not in lengths:
                lengths.append(candidate_len)

        max_start = min(8, max(0, len(normalized) - DETECT_MIN_WORDS))
        for candidate_len in lengths:
            for start in [0, 1, 2, 4, 6, max_start]:
                if start < 0 or start > max_start or (start + candidate_len) > len(normalized):
                    continue
                candidate = tuple(normalized[start:start + candidate_len])
                if len(candidate) < DETECT_MIN_WORDS or candidate in seen:
                    continue
                seen.add(candidate)
                variants.append((f"{label}:{start}:{candidate_len}", list(candidate)))

    add_variant("trimmed", trimmed_words)
    add_variant("raw", raw_words)

    if not variants and raw_words:
        fallback = raw_words[: min(len(raw_words), DETECT_MAX_WORDS)]
        if len(fallback) >= DETECT_MIN_WORDS:
            variants.append(("raw:0:fallback", fallback))
    return variants[:24]


def build_sample_starts(
    duration: float,
    snippet_duration: float,
    max_samples: int,
    min_gap_sec: float
) -> List[float]:
    max_start = max(0.0, duration - snippet_duration)
    starts: List[float] = [0.0]

    def add_start(candidate: float, gap_override: Optional[float] = None) -> None:
        normalized = clamp(candidate, 0.0, max_start)
        required_gap = max(0.5, float(gap_override if gap_override is not None else min_gap_sec))
        for existing in starts:
            if abs(existing - normalized) < required_gap:
                return
        starts.append(normalized)

    if duration >= (snippet_duration + 6.0):
        for offset in EARLY_DETECT_SAMPLE_OFFSETS_SEC:
            if len(starts) >= max_samples:
                break
            if max_start <= 0:
                break
            if offset >= max_start:
                continue
            add_start(offset, gap_override=5.5)

    if max_start >= min_gap_sec:
        add_start(max_start)

    if duration >= 50.0 and len(starts) < max_samples:
        add_start((duration * 0.40) - (snippet_duration / 2.0))
    if duration >= 80.0 and len(starts) < max_samples:
        add_start((duration * 0.62) - (snippet_duration / 2.0))
    if duration >= 140.0 and len(starts) < max_samples:
        add_start((duration * 0.78) - (snippet_duration / 2.0))

    starts = sorted(starts)
    return starts[:max_samples]


def rank_detection_candidates(
    spoken_words: List[str],
    windows: List[dict],
    inverted_index: Dict[str, List[int]],
    doc_freq: Dict[str, int]
) -> List[Tuple[int, float, int]]:
    unique_spoken = list(dict.fromkeys([word for word in spoken_words if word]))
    spoken_set = set(unique_spoken)
    if not spoken_set:
        return []

    candidate_weights: Dict[int, float] = defaultdict(float)
    for word in unique_spoken:
        indexed_windows = inverted_index.get(word) or []
        if not indexed_windows:
            continue
        frequency = max(1, int(doc_freq.get(word, 1)))
        weight = 1.0 / math.sqrt(frequency)
        for window_index in indexed_windows:
            candidate_weights[window_index] += weight

    min_overlap = 1 if len(spoken_set) <= 4 else 2
    ranked: List[Tuple[int, float, int]] = []

    if candidate_weights:
        for window_index, weight in candidate_weights.items():
            overlap = len(spoken_set.intersection(windows[window_index]["wordSet"]))
            if overlap < min_overlap:
                continue
            ranked.append((window_index, weight, overlap))
    else:
        for window_index, window in enumerate(windows):
            overlap = len(spoken_set.intersection(window["wordSet"]))
            if overlap >= min_overlap:
                ranked.append((window_index, float(overlap), overlap))

    ranked.sort(key=lambda item: (item[2], item[1]), reverse=True)
    return ranked[:DETECT_MAX_CANDIDATE_WINDOWS]


def score_detection_window(spoken_words: List[str], reference_words: List[str]) -> dict:
    quran_words = build_quran_words_from_plain(reference_words)
    base_score = score_candidate(spoken_words, quran_words)
    pairs = needleman_wunsch(spoken_words, quran_words)
    pair_scores = [
        pair_similarity
        for spoken_index, segment_index, pair_similarity in pairs
        if spoken_index is not None and segment_index is not None
    ]
    anchor_count = sum(1 for pair_score in pair_scores if pair_score >= WORD_THRESHOLD)
    pair_average = average(pair_scores, 0.0)
    anchor_ratio = anchor_count / max(1, len(spoken_words))
    overlap_ratio = len(set(spoken_words).intersection(reference_words)) / max(1, len(set(spoken_words)))
    length_penalty = abs(len(spoken_words) - len(reference_words)) / max(len(spoken_words), len(reference_words), 1)
    final_score = (
        (base_score * 0.38)
        + (pair_average * 0.32)
        + (anchor_ratio * 0.18)
        + (overlap_ratio * 0.18)
        - (length_penalty * 0.08)
    )
    return {
        "score": round(final_score, 4),
        "baseScore": round(base_score, 4),
        "pairAverage": round(pair_average, 4),
        "anchorCount": int(anchor_count),
        "anchorRatio": round(anchor_ratio, 4),
        "overlapRatio": round(overlap_ratio, 4),
        "referenceWords": len(reference_words)
    }


def score_surah_candidates_for_words(
    spoken_words: List[str],
    variant_label_prefix: str,
    windows: List[dict],
    inverted_index: Dict[str, List[int]],
    doc_freq: Dict[str, int]
) -> Tuple[Dict[int, dict], List[str]]:
    by_surah: Dict[int, dict] = {}
    strongest_variant = spoken_words[: min(len(spoken_words), DETECT_MAX_WORDS)]
    variants = build_detection_variants([
        ChunkWord(text=word, start=float(index), end=float(index + 1))
        for index, word in enumerate(spoken_words)
    ])
    if not variants:
        variants = [(f"{variant_label_prefix}:fallback", strongest_variant)]

    for variant_label, variant_words in variants:
        strongest_variant = variant_words
        ranked_candidates = rank_detection_candidates(variant_words, windows, inverted_index, doc_freq)
        for window_index, lexical_weight, overlap in ranked_candidates:
            window = windows[window_index]
            metrics = score_detection_window(variant_words, window["words"])
            score = metrics["score"] + min(0.08, lexical_weight * 0.08)
            candidate = {
                "surah": int(window["surah"]),
                "startAyah": int(window["startAyah"]),
                "endAyah": int(window["endAyah"]),
                "score": round(score, 4),
                "variant": variant_label,
                "overlap": int(overlap),
                "lexicalWeight": round(lexical_weight, 4),
                "spokenWords": len(variant_words),
                **metrics
            }
            current = by_surah.get(candidate["surah"])
            if current is None or candidate["score"] > current["score"]:
                by_surah[candidate["surah"]] = candidate
    return by_surah, strongest_variant


def detect_surah(
    audio_path: Path,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    api_key: str,
    cache_dir: Optional[Path]
) -> dict:
    duration = ffprobe_duration(audio_path, ffprobe_bin)
    snippet_duration = min(duration, DETECT_SNIPPET_SEC)
    if snippet_duration <= 0:
        raise RuntimeError("Impossible de lire l'audio pour detecter la sourate.")

    starts = build_sample_starts(
        duration=duration,
        snippet_duration=snippet_duration,
        max_samples=DETECT_MAX_SAMPLES,
        min_gap_sec=DETECT_MIN_SAMPLE_GAP_SEC
    )
    preview_samples = []

    emit("progress", stage="detect_audio", progress=0.02, message="Preparation des extraits de detection...")
    with tempfile.TemporaryDirectory(prefix="qvm-detect-surah-") as temp_dir:
        total_samples = max(1, len(starts))
        for sample_index, start_sec in enumerate(starts, start=1):
            snippet_path = Path(temp_dir) / f"detect-surah-{sample_index}.wav"
            extract_wav_chunk(audio_path, start_sec, snippet_duration, ffmpeg_bin, snippet_path)
            emit(
                "progress",
                stage="detect_transcribe",
                progress=clamp(0.06 + (sample_index / total_samples) * 0.20, 0.06, 0.26),
                message=f"Transcription detection {sample_index}/{total_samples}..."
            )
            chunk_words = transcribe_chunk(snippet_path, api_key)
            trimmed_chunk_words, _removed = trim_leading_prelude_words(chunk_words, 0)
            candidate_words = [word.text for word in trimmed_chunk_words if word.text]
            if len(candidate_words) < DETECT_MIN_WORDS:
                candidate_words = [word.text for word in chunk_words if word.text]
            candidate_words = candidate_words[:DETECT_MAX_WORDS]
            if len(candidate_words) < DETECT_MIN_WORDS:
                continue
            preview_samples.append({
                "index": sample_index - 1,
                "startSec": round(start_sec, 3),
                "snippetDuration": round(snippet_duration, 3),
                "totalDuration": round(duration, 3),
                "previewWords": candidate_words
            })

    if not preview_samples:
        raise RuntimeError("Impossible de detecter la sourate: pas assez de mots reconnus dans les extraits.")

    reference = load_detection_reference(cache_dir)
    emit("progress", stage="detect_index", progress=0.42, message="Chargement de l'index Coran...")
    windows, inverted_index, doc_freq = build_detection_windows(reference)

    aggregate_by_surah: Dict[int, dict] = {}
    strongest_variant = list(preview_samples[0]["previewWords"])
    total_samples = max(1, len(preview_samples))

    for sample_index, sample in enumerate(preview_samples, start=1):
        emit(
            "progress",
            stage="detect_match",
            progress=clamp(0.46 + (sample_index / total_samples) * 0.34, 0.46, 0.80),
            message=f"Recherche du meilleur passage ({sample_index}/{total_samples})..."
        )
        sample_words = list(sample.get("previewWords") or [])
        sample_candidates, sample_strongest_variant = score_surah_candidates_for_words(
            spoken_words=sample_words,
            variant_label_prefix=f"sample:{sample_index}",
            windows=windows,
            inverted_index=inverted_index,
            doc_freq=doc_freq
        )
        if sample_strongest_variant:
            strongest_variant = sample_strongest_variant
        if not sample_candidates:
            continue

        sample_weight = 1.0
        sample_start = float(sample.get("startSec") or 0.0)
        if sample_start <= 3.0:
            sample_weight *= 0.72
        elif sample_start <= 8.0:
            sample_weight *= 0.84
        midpoint_ratio = clamp(
            (sample_start + (snippet_duration / 2.0)) / max(duration, snippet_duration, 1.0),
            0.0,
            1.0
        )
        if 0.22 <= midpoint_ratio <= 0.88:
            sample_weight += 0.10
        if 0.38 <= midpoint_ratio <= 0.72:
            sample_weight += 0.08

        ranked_sample_candidates = sorted(sample_candidates.values(), key=lambda item: item["score"], reverse=True)
        for candidate_rank, candidate in enumerate(ranked_sample_candidates[:DETECT_TOP_CANDIDATES], start=1):
            surah = int(candidate["surah"])
            rank_weight = [1.0, 0.82, 0.68, 0.56, 0.46][candidate_rank - 1] if candidate_rank <= 5 else max(0.18, 0.46 - (candidate_rank * 0.05))
            vote = max(0.02, float(candidate["score"])) * sample_weight * rank_weight
            bucket = aggregate_by_surah.get(surah)
            if bucket is None:
                bucket = {
                    "surah": surah,
                    "totalScore": 0.0,
                    "primaryScore": 0.0,
                    "maxScore": 0.0,
                    "sampleHits": set(),
                    "primaryHits": 0,
                    "startAyah": 0,
                    "endAyah": 0,
                    "earliestSampleIndex": 10_000,
                    "previewWords": []
                }
                aggregate_by_surah[surah] = bucket

            bucket["totalScore"] += vote
            bucket["maxScore"] = max(float(bucket["maxScore"]), float(candidate["score"]))
            bucket["sampleHits"].add(sample_index - 1)
            if candidate_rank == 1:
                bucket["primaryScore"] += vote
                bucket["primaryHits"] = int(bucket["primaryHits"]) + 1

            existing_index = int(bucket["earliestSampleIndex"])
            current_index = sample_index - 1
            if current_index < existing_index or (
                current_index == existing_index and candidate_rank == 1 and float(candidate["score"]) >= float(bucket["maxScore"])
            ):
                bucket["earliestSampleIndex"] = current_index
                bucket["startAyah"] = int(candidate["startAyah"])
                bucket["endAyah"] = int(candidate["endAyah"])
                bucket["previewWords"] = sample_words[: min(len(sample_words), 24)]

    scored = sorted(
        [
            {
                "surah": int(bucket["surah"]),
                "startAyah": int(bucket["startAyah"]),
                "endAyah": int(bucket["endAyah"]),
                "score": round(
                    float(bucket["totalScore"])
                    + (float(bucket["primaryScore"]) * 0.45)
                    + (len(bucket["sampleHits"]) * 0.35)
                    + (int(bucket["primaryHits"]) * 0.18),
                    4
                ),
                "rawScore": round(float(bucket["maxScore"]), 4),
                "sampleCount": len(bucket["sampleHits"]),
                "primaryHits": int(bucket["primaryHits"]),
                "previewWords": list(bucket["previewWords"])
            }
            for bucket in aggregate_by_surah.values()
        ],
        key=lambda item: (item["score"], item["sampleCount"], item["primaryHits"], item["rawScore"]),
        reverse=True
    )
    if not scored:
        raise RuntimeError("Impossible de detecter la sourate: aucune correspondance fiable n'a ete trouvee.")

    top = scored[0]
    runner_up = scored[1] if len(scored) > 1 else None
    margin = float(top["score"]) - (float(runner_up["score"]) if runner_up else 0.0)
    effective_min_score = DETECT_SCORE_MIN
    preview_word_count = len(list(top.get("previewWords") or strongest_variant))
    if preview_word_count <= 4:
        effective_min_score = 0.11
    elif preview_word_count <= 7:
        effective_min_score = 0.15

    if top["score"] < effective_min_score:
        raise RuntimeError(
            "Impossible de detecter la sourate automatiquement. "
            "L'extrait est trop court ou trop ambigu."
        )

    support_ratio = float(top["sampleCount"]) / max(1.0, float(len(preview_samples)))
    confidence = clamp(
        (float(top["rawScore"]) * 0.46)
        + (support_ratio * 0.32)
        + max(0.0, margin * 0.22),
        0.0,
        1.0
    )
    ayah_range = (
        f"ayah {top['startAyah']}"
        if top["startAyah"] == top["endAyah"]
        else f"ayahs {top['startAyah']}-{top['endAyah']}"
    )
    message = f"Sourate detectee: {top['surah']} ({ayah_range}, {top['sampleCount']} extrait(s) concordant(s))."
    if margin < DETECT_MARGIN_MIN or confidence < 0.45:
        message = f"Sourate suggeree: {top['surah']} ({ayah_range}, verification conseillee)."

    return {
        "surah": int(top["surah"]),
        "confidence": round(confidence, 4),
        "score": round(float(top["rawScore"]), 4),
        "margin": round(margin, 4),
        "variant": "multi-sample",
        "startAyah": int(top["startAyah"]),
        "endAyah": int(top["endAyah"]),
        "message": message,
        "topCandidates": [
            {
                "surah": int(candidate["surah"]),
                "startAyah": int(candidate["startAyah"]),
                "endAyah": int(candidate["endAyah"]),
                "score": round(float(candidate["rawScore"]), 4),
                "hitCount": int(candidate["sampleCount"])
            }
            for candidate in scored[:DETECT_TOP_CANDIDATES]
        ],
        "previewWords": list(top.get("previewWords") or strongest_variant[: min(len(strongest_variant), 12)]),
        "previewSamples": [
            {
                "startSec": float(sample.get("startSec") or 0.0),
                "snippetDuration": float(sample.get("snippetDuration") or snippet_duration),
                "totalDuration": float(sample.get("totalDuration") or duration),
                "previewWords": list(sample.get("previewWords") or [])[:DETECT_MAX_WORDS]
            }
            for sample in preview_samples
        ]
    }


def run_process(args: List[str], cwd: Optional[Path] = None) -> str:
    completed = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False
    )
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(stderr or f"Commande echouee: {' '.join(args)}")
    return completed.stdout.decode("utf-8", errors="replace")


def ffprobe_duration(audio_path: Path, ffprobe_bin: str) -> float:
    output = run_process(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(audio_path)
        ]
    )
    payload = json.loads(output)
    duration = float(payload.get("format", {}).get("duration") or 0.0)
    if duration <= 0:
        raise RuntimeError("Impossible de mesurer la duree de l'audio.")
    return duration


def extract_wav_chunk(audio_path: Path, start_sec: float, duration_sec: float, ffmpeg_bin: str, out_path: Path) -> None:
    args = [
        ffmpeg_bin,
        "-y",
        "-v",
        "error",
        "-ss",
        f"{max(0.0, start_sec):.3f}",
        "-t",
        f"{max(0.01, duration_sec):.3f}",
        "-i",
        str(audio_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(out_path)
    ]
    run_process(args)


def build_multipart_request(fields: Dict[str, str], file_field: str, file_path: Path) -> Tuple[bytes, str]:
    boundary = f"----QVM{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(file_path.name)[0] or "audio/wav"
    chunks: List[bytes] = []

    for key, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    with open(file_path, "rb") as handle:
        data = handle.read()
    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
        (
            f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
    )
    chunks.append(data)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(chunks)
    return body, boundary


def transcribe_chunk(audio_path: Path, api_key: str) -> List[ChunkWord]:
    fields = {
        "model": DEFAULT_GROQ_MODEL,
        "language": "ar",
        "response_format": "verbose_json",
        "timestamp_granularities[]": "word"
    }
    body, boundary = build_multipart_request(fields, "file", audio_path)
    req = urllib.request.Request(
        GROQ_TRANSCRIPT_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
            "User-Agent": "QuranVideoMaker-PersonalizedImport/1.0"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Groq API HTTP {error.code}: {raw}")
    except urllib.error.URLError as error:
        raise RuntimeError(f"Groq API indisponible: {error.reason}")

    words: List[ChunkWord] = []
    for item in payload.get("words") or []:
        normalized = normalize_arabic(item.get("word") or "")
        if not normalized:
            continue
        start = float(item.get("start") or 0.0)
        end = float(item.get("end") or start)
        if end < start:
            end = start
        for piece in normalized.split():
            words.append(ChunkWord(text=piece, start=start, end=end))
    return words


def transcribe_preview_words(
    audio_path: Path,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    api_key: str
) -> dict:
    duration = ffprobe_duration(audio_path, ffprobe_bin)
    snippet_duration = min(duration, PREVIEW_SNIPPET_SEC)
    if snippet_duration <= 0:
        raise RuntimeError("Impossible de lire l'audio pour la pre-transcription.")

    starts = build_sample_starts(
        duration=duration,
        snippet_duration=snippet_duration,
        max_samples=PREVIEW_MAX_SAMPLES,
        min_gap_sec=PREVIEW_MIN_SAMPLE_GAP_SEC
    )
    preview_samples = []

    emit("progress", stage="detect_audio", progress=0.02, message="Preparation des extraits de detection...")
    with tempfile.TemporaryDirectory(prefix="qvm-detect-preview-") as temp_dir:
        total_samples = max(1, len(starts))
        for sample_index, start_sec in enumerate(starts, start=1):
            snippet_path = Path(temp_dir) / f"detect-preview-{sample_index}.wav"
            extract_wav_chunk(audio_path, start_sec, snippet_duration, ffmpeg_bin, snippet_path)
            emit(
                "progress",
                stage="detect_transcribe",
                progress=clamp(0.08 + (sample_index / total_samples) * 0.18, 0.08, 0.26),
                message=f"Transcription rapide de l'extrait {sample_index}/{total_samples}..."
            )
            chunk_words = transcribe_chunk(snippet_path, api_key)
            trimmed_chunk_words, _removed = trim_leading_prelude_words(chunk_words, 0)
            candidate_words = [word.text for word in trimmed_chunk_words if word.text]
            if len(candidate_words) < DETECT_MIN_WORDS:
                candidate_words = [word.text for word in chunk_words if word.text]
            candidate_words = candidate_words[:DETECT_MAX_WORDS]
            if len(candidate_words) < DETECT_MIN_WORDS:
                continue
            preview_samples.append({
                "startSec": round(start_sec, 3),
                "snippetDuration": round(snippet_duration, 3),
                "totalDuration": round(duration, 3),
                "previewWords": candidate_words
            })

    if not preview_samples:
        raise RuntimeError("Pas assez de mots reconnus pour rechercher les versets.")

    return {
        "duration": round(duration, 3),
        "snippetDuration": round(snippet_duration, 3),
        "previewWords": list(preview_samples[0]["previewWords"]),
        "previewSamples": preview_samples
    }


def chunk_ranges(total_duration: float) -> List[Tuple[float, float]]:
    ranges = []
    cursor = 0.0
    while cursor < total_duration:
        end = min(total_duration, cursor + CHUNK_DURATION_SEC)
        ranges.append((cursor, end))
        if end >= total_duration:
            break
        cursor += CHUNK_STEP_SEC
    return ranges


def score_candidate(spoken_words: List[str], quran_words: List[QuranWord]) -> float:
    spoken_text = " ".join(spoken_words)
    quran_text = " ".join(word.text for word in quran_words)
    if not spoken_text or not quran_text:
        return 0.0
    max_len = max(len(spoken_text), len(quran_text), 1)
    base = 1.0 - (levenshtein(spoken_text, quran_text) / max_len)
    penalty = abs(len(spoken_text) - len(quran_text)) / max_len
    return (0.7 * base) - (0.3 * penalty)


def search_best_segment(
    spoken_words: List[str],
    quran_words: List[QuranWord],
    start: int,
    end: int,
    min_len: int,
    max_len: int,
    stride: int = 1,
    candidate_lengths: Optional[List[int]] = None
) -> Tuple[List[QuranWord], float, int]:
    start = max(0, start)
    end = min(len(quran_words), max(start, end))
    if end - start < min_len:
        return [], -1.0, start

    if candidate_lengths is None:
        lengths = list(range(min_len, max_len + 1))
    else:
        lengths = sorted({length for length in candidate_lengths if min_len <= length <= max_len})
        if not lengths:
            lengths = list(range(min_len, max_len + 1))

    best_segment: List[QuranWord] = []
    best_score = -1.0
    best_start = start
    last_start = max(start, end - min_len)

    for candidate_start in range(start, last_start + 1, max(1, stride)):
        upper_len = min(max_len, len(quran_words) - candidate_start)
        for candidate_len in lengths:
            if candidate_len > upper_len:
                continue
            segment = quran_words[candidate_start:candidate_start + candidate_len]
            score = score_candidate(spoken_words, segment)
            if score > best_score:
                best_score = score
                best_segment = segment
                best_start = candidate_start

    if stride > 1 and best_start != last_start:
        upper_len = min(max_len, len(quran_words) - last_start)
        for candidate_len in lengths:
            if candidate_len > upper_len:
                continue
            segment = quran_words[last_start:last_start + candidate_len]
            score = score_candidate(spoken_words, segment)
            if score > best_score:
                best_score = score
                best_segment = segment
                best_start = last_start

    return best_segment, best_score, best_start


def trim_leading_prelude_words(chunk_words: List[ChunkWord], anchor_index: int) -> Tuple[List[ChunkWord], int]:
    if anchor_index > 0 or not chunk_words:
        return chunk_words, 0

    spoken_words = [word.text for word in chunk_words]
    cursor = 0
    removed = 0

    for sequence in PRELUDE_SEQUENCES:
        if cursor >= len(spoken_words):
            break
        matched = 0
        for expected in sequence:
            if cursor + matched >= len(spoken_words):
                break
            if similarity(spoken_words[cursor + matched], expected) < PRELUDE_MATCH_THRESHOLD:
                break
            matched += 1

        # Accept near-complete matches to handle ASR slips like "اعوذ/اعوذ" or "الرحمن/الرحمان".
        required = max(2, len(sequence) - 1)
        if matched >= required:
            cursor += matched
            removed += matched

            while cursor < len(spoken_words) and spoken_words[cursor] in {"قال", "صدق"}:
                cursor += 1
                removed += 1

    if removed <= 0:
        return chunk_words, 0
    return chunk_words[removed:], removed


def needleman_wunsch(spoken: List[str], quran_segment: List[QuranWord]) -> List[Tuple[Optional[int], Optional[int], float]]:
    rows = len(spoken) + 1
    cols = len(quran_segment) + 1
    scores = [[0.0] * cols for _ in range(rows)]
    back = [[None] * cols for _ in range(rows)]

    for i in range(1, rows):
        scores[i][0] = scores[i - 1][0] - 0.8
        back[i][0] = "up"
    for j in range(1, cols):
        scores[0][j] = scores[0][j - 1] - 0.8
        back[0][j] = "left"

    for i in range(1, rows):
        for j in range(1, cols):
            match_score = similarity(spoken[i - 1], quran_segment[j - 1].text)
            diag = scores[i - 1][j - 1] + match_score
            up = scores[i - 1][j] - 0.8
            left = scores[i][j - 1] - 0.8
            best = max(diag, up, left)
            scores[i][j] = best
            back[i][j] = "diag" if best == diag else ("up" if best == up else "left")

    i = len(spoken)
    j = len(quran_segment)
    pairs: List[Tuple[Optional[int], Optional[int], float]] = []
    while i > 0 or j > 0:
        move = back[i][j]
        if move == "diag":
            sim = similarity(spoken[i - 1], quran_segment[j - 1].text)
            pairs.append((i - 1, j - 1, sim))
            i -= 1
            j -= 1
        elif move == "up":
            pairs.append((i - 1, None, 0.0))
            i -= 1
        else:
            pairs.append((None, j - 1, 0.0))
            j -= 1
    pairs.reverse()
    return pairs


def find_best_alignment(
    spoken_words: List[str],
    quran_words: List[QuranWord],
    anchor_index: int,
    low_confidence_chunks: int
) -> Tuple[List[QuranWord], float, int]:
    approx_len = max(len(spoken_words), MIN_SEGMENT_WORDS)
    min_len = max(MIN_SEGMENT_WORDS, approx_len - 6)
    max_len = min(MAX_SEGMENT_WORDS, approx_len + 16)

    search_span = SEARCH_FALLBACK_WORDS if low_confidence_chunks >= 2 else TRACK_WINDOW_WORDS
    start = max(0, anchor_index - BACKWARD_MARGIN_WORDS)
    end = min(len(quran_words), start + search_span)
    if end - start < min_len:
        end = min(len(quran_words), start + max_len + 20)

    local_segment, local_score, local_start = search_best_segment(
        spoken_words=spoken_words,
        quran_words=quran_words,
        start=start,
        end=end,
        min_len=min_len,
        max_len=max_len
    )

    should_try_global = (
        low_confidence_chunks >= GLOBAL_SEARCH_TRIGGER_CHUNKS
        or local_score < SEGMENT_THRESHOLD
    )
    if not should_try_global:
        return local_segment, local_score, local_start

    coarse_lengths = sorted({
        min_len,
        max_len,
        max(min_len, min(max_len, approx_len - 4)),
        max(min_len, min(max_len, approx_len)),
        max(min_len, min(max_len, approx_len + 6)),
        max(min_len, min(max_len, approx_len + 12)),
    })
    global_segment, global_score, global_start = search_best_segment(
        spoken_words=spoken_words,
        quran_words=quran_words,
        start=max(0, anchor_index - BACKWARD_MARGIN_WORDS),
        end=len(quran_words),
        min_len=min_len,
        max_len=max_len,
        stride=GLOBAL_SEARCH_STRIDE,
        candidate_lengths=coarse_lengths
    )
    if not global_segment:
        return local_segment, local_score, local_start

    refine_start = max(0, global_start - GLOBAL_SEARCH_REFINE_WORDS)
    refine_end = min(len(quran_words), global_start + len(global_segment) + GLOBAL_SEARCH_REFINE_WORDS)
    refined_segment, refined_score, refined_start = search_best_segment(
        spoken_words=spoken_words,
        quran_words=quran_words,
        start=refine_start,
        end=refine_end,
        min_len=min_len,
        max_len=max_len
    )

    if refined_score > (local_score + 0.02):
        return refined_segment, refined_score, refined_start
    return local_segment, local_score, local_start


def merge_timing(
    target: Dict[int, dict],
    global_index: int,
    start: float,
    end: float,
    similarity_score: float
) -> None:
    entry = target.get(global_index)
    normalized_end = max(start, end)
    if entry is None:
        entry = {
            "start": start,
            "end": normalized_end,
            "similarity": similarity_score,
            "earliest_start": start,
            "occurrences": []
        }
        target[global_index] = entry

    earliest_start = min(float(entry.get("earliest_start", entry["start"])), start)
    if similarity_score >= entry["similarity"]:
        target[global_index] = {
            "start": start,
            "end": normalized_end,
            "similarity": similarity_score,
            "earliest_start": earliest_start,
            "occurrences": list(entry.get("occurrences") or [])
        }
        entry = target[global_index]

    weight_existing = max(0.1, entry["similarity"])
    weight_new = max(0.1, similarity_score)
    total = weight_existing + weight_new
    entry["start"] = ((entry["start"] * weight_existing) + (start * weight_new)) / total
    entry["end"] = ((entry["end"] * weight_existing) + (normalized_end * weight_new)) / total
    entry["similarity"] = max(entry["similarity"], similarity_score)
    entry["earliest_start"] = earliest_start
    if similarity_score >= SYNC_OCCURRENCE_MIN_SIMILARITY:
        occurrences = list(entry.get("occurrences") or [])
        merged = False
        for occurrence in occurrences:
            occ_start = float(occurrence[0])
            occ_end = float(occurrence[1])
            overlap = min(normalized_end, occ_end) - max(start, occ_start)
            shortest = min(max(MIN_WORD_DURATION_SEC, normalized_end - start), max(MIN_WORD_DURATION_SEC, occ_end - occ_start))
            if (
                abs(start - occ_start) <= SYNC_OCCURRENCE_MERGE_GAP_SEC
                and abs(normalized_end - occ_end) <= (SYNC_OCCURRENCE_MERGE_GAP_SEC * 1.5)
            ) or (
                overlap >= max(0.08, shortest * 0.42)
            ):
                occurrence[0] = min(start, occ_start)
                occurrence[1] = max(normalized_end, occ_end)
                occurrence[2] = max(similarity_score, float(occurrence[2]))
                merged = True
                break
        if not merged:
            occurrences.append([start, normalized_end, similarity_score])
            occurrences.sort(key=lambda item: float(item[0]))
            if len(occurrences) > SYNC_OCCURRENCE_MAX_PER_WORD:
                keep_head = min(2, SYNC_OCCURRENCE_MAX_PER_WORD)
                keep_tail = max(0, SYNC_OCCURRENCE_MAX_PER_WORD - keep_head)
                if keep_tail:
                    preserved = occurrences[:keep_head] + occurrences[-keep_tail:]
                else:
                    preserved = occurrences[:keep_head]
                deduped: List[List[float]] = []
                for occurrence in preserved:
                    if deduped and abs(float(occurrence[0]) - float(deduped[-1][0])) <= 0.04 and abs(float(occurrence[1]) - float(deduped[-1][1])) <= 0.08:
                        if float(occurrence[2]) >= float(deduped[-1][2]):
                            deduped[-1] = occurrence
                        continue
                    deduped.append(occurrence)
                occurrences = deduped[:SYNC_OCCURRENCE_MAX_PER_WORD]
        entry["occurrences"] = occurrences


def compute_ayah_latest_occurrence_end(
    words: List[QuranWord],
    timing_map: Dict[int, dict],
    fallback_end: float
) -> float:
    latest_end = fallback_end
    for word in words:
        entry = timing_map.get(word.global_index) or {}
        for occurrence in (entry.get("occurrences") or []):
            try:
                occurrence_end = float(occurrence[1])
            except Exception:  # pylint: disable=broad-except
                continue
            if math.isfinite(occurrence_end):
                latest_end = max(latest_end, occurrence_end)
    return latest_end


def densify_segment_timings(
    chunk_words: List[ChunkWord],
    chunk_start: float,
    best_segment: List[QuranWord],
    anchor_pairs: List[Tuple[int, int, float]],
    matched_timings: Dict[int, dict],
    similarity_score: float
) -> None:
    if not chunk_words or not best_segment:
        return

    segment_len = len(best_segment)
    abs_chunk_start = chunk_start + max(0.0, float(chunk_words[0].start))
    abs_chunk_end = chunk_start + max(float(chunk_words[-1].start), float(chunk_words[-1].end))
    if abs_chunk_end <= abs_chunk_start:
        abs_chunk_end = abs_chunk_start + max(MIN_WORD_DURATION_SEC, segment_len * MIN_WORD_DURATION_SEC)

    anchors_by_index: Dict[int, Tuple[float, float, float]] = {}
    for spoken_index, segment_index, pair_similarity in anchor_pairs:
        source = chunk_words[spoken_index]
        start = chunk_start + max(0.0, float(source.start))
        end = chunk_start + max(float(source.start), float(source.end))
        current = anchors_by_index.get(segment_index)
        if current is None or pair_similarity >= current[2]:
            anchors_by_index[segment_index] = (start, end, pair_similarity)

    centers: List[Optional[float]] = [None] * segment_len
    for segment_index, (start, end, _) in anchors_by_index.items():
        centers[segment_index] = (start + end) / 2.0

    control_points = [(-1, abs_chunk_start)]
    control_points.extend((index, center) for index, center in enumerate(centers) if center is not None)
    control_points.append((segment_len, abs_chunk_end))

    for point_index in range(len(control_points) - 1):
        left_index, left_time = control_points[point_index]
        right_index, right_time = control_points[point_index + 1]
        gap = right_index - left_index
        if gap <= 1:
            continue
        span = max(right_time - left_time, MIN_WORD_DURATION_SEC * gap)
        for segment_index in range(left_index + 1, right_index):
            ratio = (segment_index - left_index) / gap
            centers[segment_index] = left_time + (span * ratio)

    previous_end = abs_chunk_start
    for segment_index, qword in enumerate(best_segment):
        center = centers[segment_index]
        if center is None:
            center = previous_end + MIN_WORD_DURATION_SEC

        prev_center = centers[segment_index - 1] if segment_index > 0 else abs_chunk_start
        next_center = centers[segment_index + 1] if segment_index + 1 < segment_len else abs_chunk_end
        if prev_center is None:
            prev_center = previous_end
        if next_center is None:
            next_center = max(center + MIN_WORD_DURATION_SEC, abs_chunk_end)

        left_span = max(MIN_WORD_DURATION_SEC / 2.0, (center - prev_center) / 2.0)
        right_span = max(MIN_WORD_DURATION_SEC / 2.0, (next_center - center) / 2.0)
        start = max(abs_chunk_start, center - left_span)
        end = min(abs_chunk_end, center + right_span)
        start = max(previous_end, start)
        end = max(start + MIN_WORD_DURATION_SEC, end)
        previous_end = min(abs_chunk_end, end)
        merge_timing(
            matched_timings,
            qword.global_index,
            start,
            previous_end,
            similarity_score
        )


def align_chunk(
    chunk_words: List[ChunkWord],
    chunk_start: float,
    quran_words: List[QuranWord],
    matched_timings: Dict[int, dict],
    anchor_index: int,
    low_confidence_chunks: int
) -> Tuple[int, float]:
    chunk_words, _removed_prelude = trim_leading_prelude_words(chunk_words, anchor_index)
    if not chunk_words:
        return anchor_index, 0.0

    spoken_words = [word.text for word in chunk_words]
    best_segment, segment_score, segment_start = find_best_alignment(spoken_words, quran_words, anchor_index, low_confidence_chunks)
    if not best_segment:
        return anchor_index, 0.0

    pairs = needleman_wunsch(spoken_words, best_segment)
    strong_similarities = []
    timing_pairs: List[Tuple[int, int, float]] = []
    strong_anchor_pairs: List[Tuple[int, int, float]] = []

    for spoken_index, segment_index, pair_similarity in pairs:
        if spoken_index is None or segment_index is None:
            continue
        if pair_similarity < TIMING_WORD_THRESHOLD:
            continue
        qword = best_segment[segment_index]
        source = chunk_words[spoken_index]
        start = chunk_start + max(0.0, source.start)
        end = chunk_start + max(source.start, source.end)
        merge_timing(matched_timings, qword.global_index, start, end, pair_similarity)
        timing_pairs.append((spoken_index, segment_index, pair_similarity))
        if pair_similarity >= WORD_THRESHOLD:
            strong_similarities.append(pair_similarity)
            strong_anchor_pairs.append((spoken_index, segment_index, pair_similarity))

    confidence = average(timing_pairs and [pair[2] for pair in timing_pairs], 0.0)
    combined = (confidence * 0.65) + (segment_score * 0.35)
    anchor_count = len(strong_anchor_pairs)
    required_anchor_count = max(MIN_ANCHOR_MATCHES, int(math.ceil(len(best_segment) * MIN_ANCHOR_RATIO)))
    accepted = (
        combined >= LOW_CONFIDENCE_THRESHOLD
        and anchor_count >= required_anchor_count
    )
    if accepted and anchor_index == 0:
        if segment_start > INITIAL_MATCH_MAX_START_WORD and segment_score < INITIAL_MATCH_MIN_SCORE:
            accepted = False
    if not accepted:
        furthest = anchor_index
        return furthest if furthest > segment_start else max(anchor_index, furthest), combined

    densify_segment_timings(
        chunk_words=chunk_words,
        chunk_start=chunk_start,
        best_segment=best_segment,
        anchor_pairs=timing_pairs,
        matched_timings=matched_timings,
        similarity_score=INFERRED_TIMING_SIMILARITY
    )
    furthest = max(anchor_index, best_segment[-1].global_index + 1)
    return furthest if furthest > segment_start else max(anchor_index, furthest), combined


def collect_word_timings(
    audio_path: Path,
    quran_words: List[QuranWord],
    ffmpeg_bin: str,
    ffprobe_bin: str,
    api_key: str
) -> Tuple[float, Dict[int, dict], List[float]]:
    duration = ffprobe_duration(audio_path, ffprobe_bin)
    timings: Dict[int, dict] = {}
    confidences: List[float] = []
    anchor_index = 0
    low_confidence_chunks = 0

    with tempfile.TemporaryDirectory(prefix="qvm-personalized-") as temp_dir:
        temp_root = Path(temp_dir)
        ranges = chunk_ranges(duration)
        total_chunks = max(1, len(ranges))

        for chunk_index, (chunk_start, chunk_end) in enumerate(ranges, start=1):
            emit(
                "progress",
                stage="transcribe",
                progress=clamp((chunk_index - 1) / total_chunks, 0.0, 0.96),
                message=f"Transcription du bloc {chunk_index}/{total_chunks}..."
            )
            chunk_path = temp_root / f"chunk-{chunk_index:03d}.wav"
            extract_wav_chunk(audio_path, chunk_start, chunk_end - chunk_start, ffmpeg_bin, chunk_path)
            chunk_words = transcribe_chunk(chunk_path, api_key)
            if not chunk_words:
                low_confidence_chunks += 1
                continue

            anchor_index, confidence = align_chunk(
                chunk_words,
                chunk_start,
                quran_words,
                timings,
                anchor_index,
                low_confidence_chunks
            )
            confidences.append(confidence)
            if confidence < LOW_CONFIDENCE_THRESHOLD:
                low_confidence_chunks += 1
            else:
                low_confidence_chunks = 0

    return duration, timings, confidences


def fill_missing_timings(word_entries: List[QuranWord], timing_map: Dict[int, dict], total_duration: float) -> List[Tuple[float, float]]:
    known = [timing_map[word.global_index] for word in word_entries if word.global_index in timing_map]
    avg_duration = average(
        [max(MIN_WORD_DURATION_SEC, entry["end"] - entry["start"]) for entry in known],
        fallback=max(MIN_WORD_DURATION_SEC, total_duration / max(1, len(word_entries) * 3))
    )

    filled: List[Optional[Tuple[float, float]]] = [None] * len(word_entries)
    for index, word in enumerate(word_entries):
        if word.global_index in timing_map:
            entry = timing_map[word.global_index]
            filled[index] = (float(entry["start"]), float(entry["end"]))

    i = 0
    while i < len(filled):
        if filled[i] is not None:
            i += 1
            continue
        start_gap = i
        while i < len(filled) and filled[i] is None:
            i += 1
        end_gap = i
        previous = filled[start_gap - 1] if start_gap > 0 else None
        following = filled[end_gap] if end_gap < len(filled) else None
        gap_size = end_gap - start_gap

        if previous and following:
            gap_start = previous[1] + WORD_GAP_SEC
            gap_end = max(gap_start + (avg_duration * gap_size), following[0] - WORD_GAP_SEC)
            slot = max(avg_duration, (gap_end - gap_start) / max(1, gap_size))
            for offset in range(gap_size):
                s = gap_start + (slot * offset)
                e = min(following[0] - WORD_GAP_SEC, s + slot - WORD_GAP_SEC)
                if e <= s:
                    e = s + avg_duration
                filled[start_gap + offset] = (s, e)
            continue

        if previous:
            cursor = previous[1] + WORD_GAP_SEC
            for offset in range(gap_size):
                s = cursor
                e = s + avg_duration
                filled[start_gap + offset] = (s, e)
                cursor = e + WORD_GAP_SEC
            continue

        if following:
            cursor = max(0.0, following[0] - ((avg_duration + WORD_GAP_SEC) * gap_size))
            for offset in range(gap_size):
                s = cursor
                e = s + avg_duration
                filled[start_gap + offset] = (s, e)
                cursor = e + WORD_GAP_SEC
            continue

        cursor = 0.0
        for offset in range(gap_size):
            s = cursor
            e = s + avg_duration
            filled[start_gap + offset] = (s, e)
            cursor = e + WORD_GAP_SEC

    finalized: List[Tuple[float, float]] = []
    previous_end = 0.0
    for item in filled:
        if item is None:
            start = previous_end
            end = start + avg_duration
        else:
            start, end = item
        start = max(previous_end, start)
        end = max(start + MIN_WORD_DURATION_SEC, end)
        finalized.append((start, min(total_duration, end)))
        previous_end = min(total_duration, end)
    return finalized


def ayah_coverage(words: List[QuranWord], timing_map: Dict[int, dict]) -> Tuple[int, int, float]:
    matched = sum(1 for word in words if word.global_index in timing_map)
    total = len(words)
    return matched, total, (matched / total) if total else 0.0


def compute_ayah_display_start(
    words: List[QuranWord],
    timing_map: Dict[int, dict],
    fallback_start: float
) -> float:
    if not words:
        return fallback_start

    candidates: List[float] = []
    for word in words[:max(1, DISPLAY_SWITCH_WORDS)]:
        entry = timing_map.get(word.global_index)
        if not entry:
            continue
        start = float(entry.get("earliest_start", entry.get("start", fallback_start)))
        if math.isfinite(start):
            candidates.append(start)

    first_entry = timing_map.get(words[0].global_index) or {}
    first_occurrences = []
    for occurrence in (first_entry.get("occurrences") or []):
        try:
            start = float(occurrence[0])
        except Exception:  # pylint: disable=broad-except
            continue
        if math.isfinite(start):
            first_occurrences.append(start)

    if len(first_occurrences) >= 2:
        first_occurrences.sort()
        earliest_repeat = first_occurrences[0]
        if earliest_repeat < (fallback_start - 0.25):
            return max(fallback_start - MAX_STRONG_DISPLAY_LEAD_SEC, earliest_repeat)

    if not candidates:
        return fallback_start

    candidates.sort()
    if len(candidates) >= 2:
        clustered = [candidates[0]]
        for value in candidates[1:]:
            if (value - clustered[0]) <= DISPLAY_SWITCH_CLUSTER_SEC:
                clustered.append(value)
        if len(clustered) >= 2:
            return max(fallback_start - MAX_STRONG_DISPLAY_LEAD_SEC, min(clustered))

    return max(fallback_start - MAX_DISPLAY_LEAD_SEC, candidates[0] if len(words) == 1 else fallback_start)


def build_sync_segments(
    words: List[QuranWord],
    filled: List[Tuple[float, float]],
    timing_map: Dict[int, dict],
    display_start: float,
    ayah_start: float,
    ayah_end: float
) -> List[List[int]]:
    sync_segments: List[List[int]] = []
    sync_origin = min(ayah_start, display_start)

    for word_index, word in enumerate(words, start=1):
        entry = timing_map.get(word.global_index) or {}
        occurrences = entry.get("occurrences") or []
        added = False
        for occurrence in occurrences:
            try:
                start = float(occurrence[0])
                end = float(occurrence[1])
            except Exception:  # pylint: disable=broad-except
                continue
            overlap_start = max(sync_origin, start)
            overlap_end = min(ayah_end, end)
            if overlap_end <= (overlap_start + 0.01):
                continue
            clamped_start = overlap_start
            clamped_end = max(clamped_start + MIN_WORD_DURATION_SEC, overlap_end)
            rel_start = max(0, int(round((clamped_start - sync_origin) * 1000)))
            rel_end = max(rel_start, int(round((clamped_end - sync_origin) * 1000)))
            sync_segments.append([word_index, rel_start, rel_end])
            added = True

        if added:
            continue

        fallback_start, fallback_end = filled[word_index - 1]
        clamped_start = max(sync_origin, min(ayah_end, fallback_start))
        clamped_end = max(clamped_start + MIN_WORD_DURATION_SEC, min(ayah_end, fallback_end))
        rel_start = max(0, int(round((clamped_start - sync_origin) * 1000)))
        rel_end = max(rel_start, int(round((clamped_end - sync_origin) * 1000)))
        sync_segments.append([word_index, rel_start, rel_end])

    sync_segments.sort(key=lambda item: (item[1], item[2], item[0]))

    deduped: List[List[int]] = []
    for segment in sync_segments:
        if not deduped:
            deduped.append(segment)
            continue
        previous = deduped[-1]
        if (
            segment[0] == previous[0]
            and abs(segment[1] - previous[1]) <= 24
            and abs(segment[2] - previous[2]) <= 24
        ):
            continue
        deduped.append(segment)

    return deduped


def build_manifest(
    import_id: str,
    audio_path: Path,
    surah: int,
    ayah_map: Dict[int, List[QuranWord]],
    timing_map: Dict[int, dict],
    total_duration: float,
    ffmpeg_bin: str,
    output_dir: Path,
    ayah_lead_pad_sec: float,
    ayah_tail_pad_sec: float
) -> dict:
    audio_dir = output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    source_file_name = "source_full.mp3"
    source_file_path = output_dir / source_file_name
    run_process(
        [
            ffmpeg_bin,
            "-y",
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-acodec",
            "libmp3lame",
            "-b:a",
            "128k",
            str(source_file_path)
        ]
    )
    source_audio_url = f"/user-assets/personalized/{import_id}/{source_file_name}"

    manifest = {}
    ayah_ranges: List[Tuple[int, float, float, float, float, List[Tuple[float, float]]]] = []

    ayah_numbers = sorted(ayah_map.keys())
    for ayah_no in ayah_numbers:
        words = ayah_map[ayah_no]
        filled = fill_missing_timings(words, timing_map, total_duration)
        first_word_start = filled[0][0]
        last_word_end = filled[-1][1]
        raw_start = max(0.0, filled[0][0] - ayah_lead_pad_sec)
        raw_end = min(total_duration, filled[-1][1] + ayah_tail_pad_sec)
        raw_end = max(raw_start + MIN_WORD_DURATION_SEC, raw_end)
        ayah_ranges.append((ayah_no, raw_start, raw_end, first_word_start, last_word_end, filled))

    final_ranges: List[Tuple[int, float, float, float, List[Tuple[float, float]]]] = []
    previous_display_start = 0.0
    for index, (ayah_no, raw_start, raw_end, first_word_start, last_word_end, filled) in enumerate(ayah_ranges):
        words = ayah_map.get(ayah_no, [])
        ayah_start = raw_start
        ayah_end = raw_end
        if index + 1 < len(ayah_ranges):
            next_first_word_start = ayah_ranges[index + 1][3]
            ayah_end = min(ayah_end, next_first_word_start)
        latest_occurrence_end = compute_ayah_latest_occurrence_end(words, timing_map, last_word_end)
        ayah_end = max(last_word_end, ayah_end)
        ayah_end = max(ayah_end, min(raw_end + MAX_REPEAT_EXTENSION_SEC, latest_occurrence_end + AYAH_PAD_SEC))
        ayah_end = max(ayah_start + MIN_WORD_DURATION_SEC, ayah_end)
        display_start = compute_ayah_display_start(words, timing_map, ayah_start)
        display_start = max(previous_display_start + 0.001, min(ayah_start, display_start))
        previous_display_start = display_start
        final_ranges.append((ayah_no, ayah_start, min(total_duration, ayah_end), display_start, filled))

    for ayah_no, ayah_start, ayah_end, display_start, filled in final_ranges:
        rel_segments = []
        for index, (start, end) in enumerate(filled, start=1):
            clamped_start = max(ayah_start, min(ayah_end, start))
            clamped_end = max(clamped_start, min(ayah_end, end))
            rel_start = max(0, int(round((clamped_start - ayah_start) * 1000)))
            rel_end = max(rel_start, int(round((clamped_end - ayah_start) * 1000)))
            rel_segments.append([index, rel_start, rel_end])
        sync_segments = build_sync_segments(
            words=ayah_map.get(ayah_no, []),
            filled=filled,
            timing_map=timing_map,
            display_start=display_start,
            ayah_start=ayah_start,
            ayah_end=ayah_end
        )

        file_name = f"{pad3(surah)}{pad3(ayah_no)}.mp3"
        file_path = audio_dir / file_name
        run_process(
            [
                ffmpeg_bin,
                "-y",
                "-v",
                "error",
                "-ss",
                f"{ayah_start:.3f}",
                "-to",
                f"{ayah_end:.3f}",
                "-i",
                str(audio_path),
                "-acodec",
                "libmp3lame",
                "-b:a",
                "128k",
                str(file_path)
            ]
        )

        manifest[f"{surah}:{ayah_no}"] = {
            "surah_number": surah,
            "ayah_number": ayah_no,
            "audio_url": f"/user-assets/personalized/{import_id}/audio/{file_name}",
            "source_audio_url": source_audio_url,
            "display_start_ms": int(round(display_start * 1000)),
            "source_start_ms": int(round(ayah_start * 1000)),
            "source_end_ms": int(round(ayah_end * 1000)),
            "duration": int(round((ayah_end - ayah_start) * 1000)),
            "segments": rel_segments,
            "sync_segments": sync_segments
        }

    return manifest


def compress_ayah_ranges(ayah_numbers: List[int]) -> List[Tuple[int, int]]:
    ordered = sorted({int(ayah) for ayah in ayah_numbers if int(ayah) > 0})
    if not ordered:
        return []

    ranges: List[Tuple[int, int]] = []
    start_ayah = ordered[0]
    previous_ayah = ordered[0]
    for ayah_no in ordered[1:]:
        if ayah_no == (previous_ayah + 1):
            previous_ayah = ayah_no
            continue
        ranges.append((start_ayah, previous_ayah))
        start_ayah = ayah_no
        previous_ayah = ayah_no
    ranges.append((start_ayah, previous_ayah))
    return ranges


def validate_alignment(
    quran_words: List[QuranWord],
    ayah_map: Dict[int, List[QuranWord]],
    timing_map: Dict[int, dict]
) -> Dict[str, float]:
    total_words = len(quran_words)
    matched_words = sum(1 for word in quran_words if word.global_index in timing_map)
    matched_word_ratio = (matched_words / total_words) if total_words else 0.0

    ayah_coverages = [ayah_coverage(words, timing_map) for words in ayah_map.values()]
    matched_ayahs = sum(1 for _, _, coverage in ayah_coverages if coverage >= MIN_AYAH_COVERAGE)
    total_ayahs = len(ayah_coverages)
    matched_ayah_ratio = (matched_ayahs / total_ayahs) if total_ayahs else 0.0

    last_word_index = max((word.global_index for word in quran_words if word.global_index in timing_map), default=-1)
    last_word_ratio = ((last_word_index + 1) / total_words) if total_words else 0.0

    return {
        "matchedWords": matched_words,
        "totalWords": total_words,
        "coverageRatio": matched_word_ratio,
        "matchedAyahs": matched_ayahs,
        "totalAyahs": total_ayahs,
        "ayahCoverageRatio": matched_ayah_ratio,
        "lastWordRatio": last_word_ratio
    }


def passes_relaxed_alignment_validation(stats: Dict[str, float]) -> bool:
    coverage_ratio = float(stats.get("coverageRatio") or 0.0)
    ayah_ratio = float(stats.get("ayahCoverageRatio") or 0.0)
    last_word_ratio = float(stats.get("lastWordRatio") or 0.0)
    return (
        coverage_ratio >= RELAXED_MIN_COVERAGE_RATIO
        and ayah_ratio >= RELAXED_MIN_AYAH_RATIO
        and last_word_ratio >= RELAXED_MIN_LAST_WORD_REACHED
    )


def write_json(path_obj: Path, payload: dict) -> None:
    path_obj.parent.mkdir(parents=True, exist_ok=True)
    with open(path_obj, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def read_json_file(path_obj: Path) -> dict:
    with open(path_obj, "r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline personalized recitation import")
    parser.add_argument("--audio-file", required=True)
    parser.add_argument("--surah", type=int)
    parser.add_argument("--start-ayah", type=int, default=1)
    parser.add_argument("--display-name")
    parser.add_argument("--import-id")
    parser.add_argument("--output-dir")
    parser.add_argument("--cache-dir")
    parser.add_argument("--lead-pad-ms", type=int, default=int(round(DEFAULT_AYAH_LEAD_PAD_SEC * 1000)))
    parser.add_argument("--tail-pad-ms", type=int, default=int(round(DEFAULT_AYAH_TAIL_PAD_SEC * 1000)))
    parser.add_argument("--detect-surah-only", action="store_true")
    parser.add_argument("--transcribe-preview-only", action="store_true")
    parser.add_argument("--rebuild-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audio_path = Path(args.audio_file).expanduser().resolve()

    if not audio_path.exists():
        emit("error", stage="input", message="Le fichier audio selectionne est introuvable.")
        return 1

    ffmpeg_bin = os.getenv("FFMPEG_BIN") or "ffmpeg"
    ffprobe_bin = os.getenv("FFPROBE_BIN") or "ffprobe"
    api_key = os.getenv("GROQ_API_KEY") or os.getenv("PERSONALIZED_GROQ_API_KEY")
    if not args.rebuild_only and not api_key:
        emit("error", stage="asr", message="GROQ_API_KEY manquant. Configure la cle API avant l'import personnalise.")
        return 1

    try:
        if args.transcribe_preview_only:
            preview = transcribe_preview_words(
                audio_path=audio_path,
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
                api_key=api_key
            )
            emit(
                "complete",
                stage="transcribed",
                progress=1.0,
                message="Extrait transcrit.",
                duration=preview.get("duration"),
                snippetDuration=preview.get("snippetDuration"),
                previewWords=preview.get("previewWords") or []
            )
            return 0

        if args.detect_surah_only:
            cache_dir = Path(args.cache_dir).expanduser().resolve() if args.cache_dir else None
            detection = detect_surah(
                audio_path=audio_path,
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
                api_key=api_key,
                cache_dir=cache_dir
            )
            emit(
                "complete",
                stage="detected",
                progress=1.0,
                message=detection.get("message") or "Sourate detectee.",
                surah=detection.get("surah"),
                confidence=detection.get("confidence"),
                startAyah=detection.get("startAyah"),
                endAyah=detection.get("endAyah"),
                topCandidates=detection.get("topCandidates") or [],
                previewWords=detection.get("previewWords") or [],
                previewSamples=detection.get("previewSamples") or []
            )
            return 0

        missing = []
        if not args.surah:
            missing.append("--surah")
        if not args.display_name:
            missing.append("--display-name")
        if not args.import_id:
            missing.append("--import-id")
        if not args.output_dir:
            missing.append("--output-dir")
        if missing:
            raise RuntimeError("Arguments manquants pour l'import personnalise: " + ", ".join(missing))

        output_dir = Path(args.output_dir).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        lead_pad_sec = clamp((args.lead_pad_ms or 0) / 1000.0, 0.0, 1.0)
        tail_pad_sec = clamp((args.tail_pad_ms or 0) / 1000.0, 0.0, 2.0)

        start_ayah = max(1, int(args.start_ayah or 1))
        emit(
            "progress",
            stage="quran",
            progress=0.02,
            message=f"Chargement de la sourate {args.surah} a partir du verset {start_ayah}..."
        )
        quran_words, ayah_map = fetch_surah_words(args.surah, start_ayah=start_ayah)

        if args.rebuild_only:
            analysis_path = output_dir / "analysis.json"
            if not analysis_path.exists():
                raise RuntimeError("Impossible de reconstruire cet import: analysis.json est introuvable.")
            emit("progress", stage="analysis", progress=0.12, message="Chargement de l'analyse existante...")
            analysis_payload = read_json_file(analysis_path)
            summary = dict(analysis_payload.get("summary") or {})
            timing_map = {
                int(key): value
                for key, value in (analysis_payload.get("timings") or {}).items()
            }
            duration = ffprobe_duration(audio_path, ffprobe_bin)
            stats = validate_alignment(quran_words, ayah_map, timing_map)
        else:
            emit("progress", stage="audio_probe", progress=0.08, message="Analyse de la duree audio...")
            duration, timing_map, confidences = collect_word_timings(
                audio_path=audio_path,
                quran_words=quran_words,
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
                api_key=api_key
            )

            emit("progress", stage="validation", progress=0.84, message="Validation de la couverture...")
            stats = validate_alignment(quran_words, ayah_map, timing_map)
            average_confidence = average(confidences, 0.0)
            relaxed_validation = passes_relaxed_alignment_validation(stats)

            if stats["coverageRatio"] < MIN_COVERAGE_RATIO and not relaxed_validation:
                raise RuntimeError(
                    f"Couverture trop faible ({stats['coverageRatio']:.0%}). "
                    f"Ayahs suffisamment couverts: {stats['ayahCoverageRatio']:.0%}. "
                    f"Fin de sourate atteinte: {stats['lastWordRatio']:.0%}. "
                    "Le fichier ne ressemble pas assez a la sourate choisie."
                )
            if stats["ayahCoverageRatio"] < 0.50 and not relaxed_validation:
                raise RuntimeError(
                    f"Trop peu d'ayahs couverts ({stats['ayahCoverageRatio']:.0%}). "
                    f"Couverture mots: {stats['coverageRatio']:.0%}. "
                    "Le fichier semble tronque ou ne correspond pas a une sourate complete."
                )
            if stats["lastWordRatio"] < MIN_LAST_WORD_REACHED:
                raise RuntimeError(
                    f"La fin de la sourate n'a pas ete suffisamment atteinte ({stats['lastWordRatio']:.0%}). "
                    f"Couverture mots: {stats['coverageRatio']:.0%}. "
                    "Le fichier semble incomplet ou melange plusieurs sourates."
                )

            summary = {
                "backend": "groq_whisper",
                "model": DEFAULT_GROQ_MODEL,
                "durationSec": round(duration, 3),
                "matchedWords": int(stats["matchedWords"]),
                "totalWords": int(stats["totalWords"]),
                "coverageRatio": round(stats["coverageRatio"], 4),
                "matchedAyahs": int(stats["matchedAyahs"]),
                "totalAyahs": int(stats["totalAyahs"]),
                "averageConfidence": round(average_confidence, 4),
                "generatedAt": iso_now()
            }

        emit("progress", stage="manifest", progress=0.89, message="Generation du manifest local...")
        manifest = build_manifest(
            import_id=args.import_id,
            audio_path=audio_path,
            surah=args.surah,
            ayah_map=ayah_map,
            timing_map=timing_map,
            total_duration=duration,
            ffmpeg_bin=ffmpeg_bin,
            output_dir=output_dir,
            ayah_lead_pad_sec=lead_pad_sec,
            ayah_tail_pad_sec=tail_pad_sec
        )

        covered_ayah_ranges = compress_ayah_ranges(list(ayah_map.keys()))
        covered_start_ayah = int(covered_ayah_ranges[0][0]) if covered_ayah_ranges else int(start_ayah)
        covered_end_ayah = int(covered_ayah_ranges[-1][1]) if covered_ayah_ranges else int(start_ayah)

        metadata = {
            "id": args.import_id,
            "name": args.display_name,
            "type": "personalized",
            "formatVersion": PERSONALIZED_IMPORT_FORMAT_VERSION,
            "surah": int(args.surah),
            "startAyah": covered_start_ayah,
            "endAyah": covered_end_ayah,
            "coveredAyahRanges": [
                {
                    "startAyah": int(range_start),
                    "endAyah": int(range_end)
                }
                for range_start, range_end in covered_ayah_ranges
            ],
            "sourceAudioPath": str(audio_path),
            "sourceAudioUrl": f"/user-assets/personalized/{args.import_id}/source_full.mp3",
            "manifestPath": f"/user-assets/personalized/{args.import_id}/manifest.json",
            "manifestFilePath": str(output_dir / "manifest.json"),
            "status": "ready",
            "slicing": {
                "leadPadMs": int(round(lead_pad_sec * 1000)),
                "tailPadMs": int(round(tail_pad_sec * 1000))
            },
            "analysisSummary": summary,
            "createdAt": iso_now(),
            "updatedAt": iso_now()
        }

        write_json(output_dir / "manifest.json", manifest)
        write_json(output_dir / "metadata.json", metadata)
        write_json(
            output_dir / "analysis.json",
            {
                "summary": summary,
                "validation": stats,
                "timings": timing_map
            }
        )

        emit("complete", stage="complete", progress=1.0, message="Import personnalise termine.")
        return 0
    except Exception as error:  # pylint: disable=broad-except
        emit("error", stage="failed", message=str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
