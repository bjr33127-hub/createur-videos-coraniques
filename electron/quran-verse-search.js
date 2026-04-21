const {
  LRUCache,
  buildInvertedIndex,
  createArabicFuseSearch,
  loadMorphology,
  loadQuranData,
  loadWordMap,
  normalizeArabic,
  search
} = require("quran-search-engine");

const SEARCH_OPTIONS = Object.freeze({
  fuzzy: true,
  lemma: true,
  root: true,
  semantic: false
});

const SEARCH_PAGINATION = Object.freeze({
  page: 1,
  limit: 6
});

const SEARCH_CACHE = new LRUCache(160);
const PREVIEW_SAMPLE_RANK_WEIGHTS = Object.freeze([1, 0.82, 0.68, 0.56, 0.46]);

let enginePromise = null;

function clampNumber(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

async function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [quranData, morphologyMap, wordMap] = await Promise.all([
        loadQuranData(),
        loadMorphology(),
        loadWordMap()
      ]);
      const verses = [...quranData.values()];
      const invertedIndex = buildInvertedIndex(morphologyMap, quranData);
      const fuseIndex = createArabicFuseSearch(verses, ["standard", "uthmani"]);
      return {
        context: { quranData, morphologyMap, wordMap, invertedIndex },
        fuseIndex
      };
    })().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

function normalizeWords(words) {
  return (Array.isArray(words) ? words : [])
    .map((word) => normalizeArabic(String(word || "").trim()))
    .filter(Boolean);
}

function buildQueryVariants(words) {
  const normalized = normalizeWords(words);
  const variants = [];
  const seen = new Set();
  const addVariant = (start, length) => {
    if (start < 0 || length < 2 || start >= normalized.length) return;
    const slice = normalized.slice(start, start + length);
    if (slice.length < 2) return;
    const key = `${start}:${slice.join(" ")}`;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({
      start,
      words: slice,
      query: slice.join(" ")
    });
  };

  const prefixLengths = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
  for (const length of prefixLengths) addVariant(0, length);

  const shortStarts = [1, 2];
  const shortLengths = [2, 3, 4, 5, 6];
  for (const start of shortStarts) {
    for (const length of shortLengths) addVariant(start, length);
  }

  if (normalized.length >= 10) {
    const middle = Math.max(0, Math.floor((normalized.length - 6) / 2));
    for (const start of [middle]) {
      for (const length of [4, 6]) addVariant(start, length);
    }
  }

  return variants.slice(0, 28);
}

function computeVariantWeight(variant) {
  const tokenCount = Array.isArray(variant?.words) ? variant.words.length : 0;
  let weight = Math.min(2.4, 0.7 + (tokenCount * 0.17));
  const start = Number(variant?.start || 0);
  if (start === 0) weight *= 1.45;
  else if (start === 1) weight *= 0.72;
  else if (start === 2) weight *= 0.52;
  else weight *= 0.35;
  if (tokenCount >= 6) weight += 0.16;
  return weight;
}

function computeNormalizedHit(result, tokenCount) {
  const maxExactScore = Math.max(3, tokenCount * 3);
  const normalized = clampNumber(Number(result?.matchScore || 0) / maxExactScore, 0, 1, 0);
  const matchedTokens = Array.isArray(result?.matchedTokens) ? result.matchedTokens.length : 0;
  return {
    matchedTokens,
    normalized
  };
}

function detectBestAyahRange(ayahScores) {
  const entries = [...ayahScores.entries()]
    .map(([ayah, score]) => ({ ayah: Number(ayah), score: Number(score || 0) }))
    .filter((entry) => Number.isFinite(entry.ayah) && entry.ayah > 0 && entry.score > 0)
    .sort((a, b) => a.ayah - b.ayah);

  if (!entries.length) return { startAyah: 0, endAyah: 0, uniqueAyahs: 0 };

  let best = {
    startAyah: entries[0].ayah,
    endAyah: entries[0].ayah,
    totalScore: entries[0].score,
    uniqueAyahs: 1
  };

  let current = {
    startAyah: entries[0].ayah,
    endAyah: entries[0].ayah,
    totalScore: entries[0].score,
    uniqueAyahs: 1
  };

  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index];
    const previous = entries[index - 1];
    if (entry.ayah <= (previous.ayah + 1)) {
      current.endAyah = entry.ayah;
      current.totalScore += entry.score;
      current.uniqueAyahs += 1;
    } else {
      if (current.totalScore > best.totalScore) best = { ...current };
      current = {
        startAyah: entry.ayah,
        endAyah: entry.ayah,
        totalScore: entry.score,
        uniqueAyahs: 1
      };
    }
  }

  if (current.totalScore > best.totalScore) best = { ...current };
  return best;
}

function summarizeCandidates(hitBuckets) {
  const candidates = [];
  for (const bucket of hitBuckets.values()) {
    const range = detectBestAyahRange(bucket.ayahScores);
    const runnerUpPenalty = Math.min(0.8, bucket.maxNormalized * 0.35);
    const score = (
      (bucket.totalScore * 0.55)
      + (bucket.prefixScore * 1.25)
      + (bucket.maxNormalized * 1.1)
      + (Math.min(4, bucket.hitCount) * 0.12)
      + (Math.min(3, range.uniqueAyahs) * 0.12)
      - runnerUpPenalty
    );
    candidates.push({
      surah: bucket.surah,
      score,
      confidenceHint: bucket.maxNormalized,
      hitCount: bucket.hitCount,
      startAyah: range.startAyah || bucket.bestAyah || 0,
      endAyah: range.endAyah || bucket.bestAyah || 0
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function normalizeSearchOptions(options = {}) {
  return {
    preferredSurah: Number(options?.preferredSurah || 0),
    strictSurah: options?.strictSurah === true
  };
}

function resolveVariantMatchThresholds(variant, surah, options = {}) {
  const tokenCount = Array.isArray(variant?.words) ? variant.words.length : 0;
  const preferredSurah = Number(options?.preferredSurah || 0);
  const strictSurah = options?.strictSurah === true;
  const isStrictPreferredHit = strictSurah && preferredSurah > 0 && surah === preferredSurah;

  let minMatchedTokens = Math.min(2, Math.max(1, tokenCount));
  let minNormalized = tokenCount <= 3 ? 0.34 : 0.45;

  if (isStrictPreferredHit) {
    if (tokenCount <= 3) {
      minMatchedTokens = 1;
      minNormalized = 0.18;
    } else if (tokenCount <= 5) {
      minMatchedTokens = 1;
      minNormalized = 0.24;
    }
  }

  return { minMatchedTokens, minNormalized, isStrictPreferredHit };
}

async function detectVerseRangeFromWords(words, options = {}) {
  const normalizedWords = normalizeWords(words);
  if (normalizedWords.length < 2) {
    throw new Error("Pas assez de mots reconnus pour lancer la recherche de versets.");
  }

  const { preferredSurah, strictSurah } = normalizeSearchOptions(options);
  const { context, fuseIndex } = await loadEngine();
  const variants = buildQueryVariants(normalizedWords);
  const hitBuckets = new Map();
  const preferredHitBuckets = preferredSurah > 0 ? new Map() : null;

  for (const variant of variants) {
    const variantWeight = computeVariantWeight(variant);
    const response = search(
      variant.query,
      context,
      SEARCH_OPTIONS,
      SEARCH_PAGINATION,
      fuseIndex,
      SEARCH_CACHE
    );

    for (const result of response?.results || []) {
      const surah = Number(result?.sura_id || 0);
      const ayah = Number(result?.aya_id || 0);
      if (!(surah > 0) || !(ayah > 0)) continue;
      if (strictSurah && preferredSurah > 0 && surah !== preferredSurah) continue;

      const { matchedTokens, normalized } = computeNormalizedHit(result, variant.words.length);
      if (!Number.isFinite(normalized) || normalized <= 0) continue;
      if (String(result?.matchType || "none") === "none") continue;
      const { minMatchedTokens, minNormalized, isStrictPreferredHit } = resolveVariantMatchThresholds(variant, surah, {
        preferredSurah,
        strictSurah
      });
      if (matchedTokens < minMatchedTokens) continue;
      if (normalized < minNormalized) continue;

      const typeWeight = String(result?.matchType || "") === "exact" ? 1.2 : 0.95;
      const preferredHitBoost = isStrictPreferredHit && Number(variant?.start || 0) === 0 ? 1.08 : 1;
      const hitScore = normalized * variantWeight * typeWeight * preferredHitBoost;

      const applyHit = (bucketMap) => {
        let bucket = bucketMap.get(surah);
        if (!bucket) {
          bucket = {
            surah,
            totalScore: 0,
            prefixScore: 0,
            maxNormalized: 0,
            hitCount: 0,
            bestAyah: ayah,
            ayahScores: new Map()
          };
          bucketMap.set(surah, bucket);
        }
        bucket.totalScore += hitScore;
        if (Number(variant.start || 0) === 0) {
          bucket.prefixScore += hitScore;
        }
        bucket.hitCount += 1;
        if (normalized > bucket.maxNormalized) {
          bucket.maxNormalized = normalized;
          bucket.bestAyah = ayah;
        }
        bucket.ayahScores.set(ayah, Number(bucket.ayahScores.get(ayah) || 0) + hitScore);
      };

      applyHit(hitBuckets);
      if (preferredHitBuckets && surah === preferredSurah) {
        applyHit(preferredHitBuckets);
      }
    }
  }

  let candidates = [];
  if (preferredHitBuckets && preferredHitBuckets.size > 0) {
    candidates = summarizeCandidates(preferredHitBuckets);
  }
  if (!candidates.length) {
    candidates = summarizeCandidates(hitBuckets);
  }
  if (!candidates.length) {
    throw new Error("Aucune correspondance de verset fiable n'a ete trouvee.");
  }

  const top = candidates[0];
  const runnerUp = candidates[1] || null;
  const rawMargin = top.score - Number(runnerUp?.score || 0);
  const marginRatio = clampNumber(rawMargin / Math.max(top.score || 1, 1), 0, 1, 0);
  const confidence = clampNumber(
    (top.confidenceHint * 0.50)
      + (Math.min(5, top.hitCount) / 5) * 0.10
      + (marginRatio * 0.40),
    0,
    1,
    0
  );
  const message = (
    top.startAyah && top.endAyah
      ? (
        top.startAyah === top.endAyah
          ? `${confidence >= 0.65 ? "Sourate detectee" : "Sourate suggeree"}: ${top.surah} (ayah ${top.startAyah}).`
          : `${confidence >= 0.65 ? "Sourate detectee" : "Sourate suggeree"}: ${top.surah} (ayahs ${top.startAyah}-${top.endAyah}).`
      )
      : `${confidence >= 0.65 ? "Sourate detectee" : "Sourate suggeree"}: ${top.surah}.`
  );

  return {
    surah: top.surah,
    startAyah: top.startAyah,
    endAyah: top.endAyah,
    confidence,
    score: clampNumber(top.confidenceHint, 0, 1, 0),
    margin: marginRatio,
    topCandidates: candidates.slice(0, 5).map((candidate) => ({
      surah: candidate.surah,
      startAyah: candidate.startAyah,
      endAyah: candidate.endAyah,
      score: clampNumber(candidate.confidenceHint, 0, 1, 0),
      hitCount: candidate.hitCount
    })),
    message
  };
}

function normalizePreviewSamples(previewSamples) {
  return (Array.isArray(previewSamples) ? previewSamples : [])
    .map((sample, index) => {
      const words = normalizeWords(sample?.previewWords || sample?.words || []);
      return {
        index,
        words,
        startSec: clampNumber(sample?.startSec, 0, Number.MAX_SAFE_INTEGER, 0),
        snippetDuration: clampNumber(sample?.snippetDuration, 0, Number.MAX_SAFE_INTEGER, 0),
        totalDuration: clampNumber(sample?.totalDuration, 0, Number.MAX_SAFE_INTEGER, 0)
      };
    })
    .filter((sample) => sample.words.length >= 2);
}

function computePreviewSampleWeight(sample, totalSamples) {
  const startSec = Number(sample?.startSec || 0);
  const snippetDuration = Number(sample?.snippetDuration || 0);
  const totalDuration = Number(sample?.totalDuration || 0);
  const wordCount = Array.isArray(sample?.words) ? sample.words.length : 0;
  let weight = 0.92 + Math.min(0.30, Math.max(0, wordCount - 3) * 0.03);

  if (startSec <= 3) {
    weight *= 0.72;
  } else if (startSec <= 8) {
    weight *= 0.84;
  }

  if (totalDuration > 0 && snippetDuration > 0) {
    const midpointRatio = clampNumber(
      (startSec + (snippetDuration / 2)) / Math.max(totalDuration, snippetDuration, 1),
      0,
      1,
      0
    );
    if (midpointRatio >= 0.22 && midpointRatio <= 0.88) {
      weight += 0.10;
    }
    if (midpointRatio >= 0.38 && midpointRatio <= 0.72) {
      weight += 0.08;
    }
  }

  if (totalSamples >= 3 && sample.index > 0) {
    weight += 0.06;
  }

  return weight;
}

function buildPreviewDetectionMessage(top, confidence, successfulSampleCount) {
  const confidenceLabel = confidence >= 0.68 ? "Sourate detectee" : "Sourate suggeree";
  if (top.startAyah > 0 && top.endAyah > 0) {
    const ayahLabel = top.startAyah === top.endAyah
      ? `ayah ${top.startAyah}`
      : `ayahs ${top.startAyah}-${top.endAyah}`;
    return `${confidenceLabel}: ${top.surah} (${ayahLabel}, ${successfulSampleCount} extrait${successfulSampleCount > 1 ? "s" : ""} concordant${successfulSampleCount > 1 ? "s" : ""}).`;
  }
  return `${confidenceLabel}: ${top.surah} (${successfulSampleCount} extrait${successfulSampleCount > 1 ? "s" : ""} concordant${successfulSampleCount > 1 ? "s" : ""}).`;
}

async function detectVerseRangeFromPreviewSamples(previewSamples, options = {}) {
  const samples = normalizePreviewSamples(previewSamples);
  if (!samples.length) {
    throw new Error("Pas assez d'extraits reconnus pour detecter la sourate.");
  }
  if (samples.length === 1) {
    const single = await detectVerseRangeFromWords(samples[0].words, options);
    return {
      ...single,
      previewWords: samples[0].words
    };
  }

  const successfulSamples = [];
  for (const sample of samples) {
    try {
      const detection = await detectVerseRangeFromWords(sample.words, options);
      successfulSamples.push({ sample, detection });
    } catch (_) {
      // Ignore weak/ambiguous snippets and keep the stronger ones.
    }
  }

  if (!successfulSamples.length) {
    throw new Error("Aucune correspondance de sourate fiable n'a ete trouvee.");
  }
  if (successfulSamples.length === 1) {
    return {
      ...successfulSamples[0].detection,
      previewWords: successfulSamples[0].sample.words
    };
  }

  const buckets = new Map();

  for (const [sampleIndex, entry] of successfulSamples.entries()) {
    const { sample, detection } = entry;
    const sampleWeight = computePreviewSampleWeight(sample, samples.length);
    const primarySurah = Number(detection?.surah || 0);
    const candidates = Array.isArray(detection?.topCandidates) && detection.topCandidates.length
      ? detection.topCandidates
      : [{
          surah: primarySurah,
          startAyah: Number(detection?.startAyah || 0),
          endAyah: Number(detection?.endAyah || 0),
          score: Number(detection?.score || detection?.confidence || 0),
          hitCount: 0
        }];

    candidates.forEach((candidate, candidateIndex) => {
      const surah = Number(candidate?.surah || 0);
      if (!(surah > 0)) return;

      let bucket = buckets.get(surah);
      if (!bucket) {
        bucket = {
          surah,
          totalScore: 0,
          primaryScore: 0,
          maxScore: 0,
          topHitCount: 0,
          sampleIndices: new Set(),
          earliestSampleIndex: Number.MAX_SAFE_INTEGER,
          earliestScore: -1,
          startAyah: 0,
          endAyah: 0,
          previewWords: []
        };
        buckets.set(surah, bucket);
      }

      const rankWeight = PREVIEW_SAMPLE_RANK_WEIGHTS[candidateIndex] || Math.max(0.18, 0.46 - (candidateIndex * 0.05));
      const candidateScore = clampNumber(Number(candidate?.score ?? detection?.score ?? detection?.confidence ?? 0), 0, 1, 0);
      const hitCount = clampNumber(Number(candidate?.hitCount || 0), 0, 20, 0);
      const hitBoost = 1 + Math.min(0.20, hitCount * 0.03);
      const isPrimary = candidateIndex === 0 || surah === primarySurah;
      const vote = Math.max(0.02, candidateScore) * sampleWeight * rankWeight * hitBoost * (isPrimary ? 1.18 : 1);

      bucket.totalScore += vote;
      if (isPrimary) {
        bucket.primaryScore += vote;
      }
      if (candidateIndex === 0) {
        bucket.topHitCount += 1;
      }
      bucket.maxScore = Math.max(bucket.maxScore, candidateScore);
      bucket.sampleIndices.add(sampleIndex);

      const sourceStartAyah = surah === primarySurah
        ? Number(detection?.startAyah || candidate?.startAyah || 0)
        : Number(candidate?.startAyah || 0);
      const sourceEndAyah = surah === primarySurah
        ? Number(detection?.endAyah || candidate?.endAyah || sourceStartAyah || 0)
        : Number(candidate?.endAyah || sourceStartAyah || 0);

      if (
        sampleIndex < bucket.earliestSampleIndex
        || (sampleIndex === bucket.earliestSampleIndex && isPrimary && candidateScore > bucket.earliestScore)
      ) {
        bucket.earliestSampleIndex = sampleIndex;
        bucket.earliestScore = candidateScore;
        bucket.startAyah = sourceStartAyah;
        bucket.endAyah = sourceEndAyah;
        bucket.previewWords = sample.words;
      }
    });
  }

  const ranked = [...buckets.values()]
    .map((bucket) => {
      const sampleCount = bucket.sampleIndices.size;
      return {
        ...bucket,
        sampleCount,
        combinedScore: (
          bucket.totalScore
          + (bucket.primaryScore * 0.45)
          + (sampleCount * 0.35)
          + (bucket.topHitCount * 0.18)
        )
      };
    })
    .sort((a, b) => (
      b.combinedScore - a.combinedScore
      || b.sampleCount - a.sampleCount
      || b.primaryScore - a.primaryScore
      || b.maxScore - a.maxScore
    ));

  const top = ranked[0];
  const runnerUp = ranked[1] || null;
  const supportRatio = clampNumber(top.sampleCount / Math.max(1, successfulSamples.length), 0, 1, 0);
  const marginRatio = clampNumber(
    (top.combinedScore - Number(runnerUp?.combinedScore || 0)) / Math.max(top.combinedScore || 1, 1),
    0,
    1,
    0
  );
  const confidence = clampNumber(
    (top.maxScore * 0.45)
      + (supportRatio * 0.35)
      + (marginRatio * 0.20),
    0,
    1,
    0
  );

  return {
    surah: top.surah,
    startAyah: Number(top.startAyah || 0),
    endAyah: Number(top.endAyah || top.startAyah || 0),
    confidence,
    score: clampNumber(top.maxScore, 0, 1, 0),
    margin: marginRatio,
    topCandidates: ranked.slice(0, 5).map((candidate) => ({
      surah: candidate.surah,
      startAyah: Number(candidate.startAyah || 0),
      endAyah: Number(candidate.endAyah || candidate.startAyah || 0),
      score: clampNumber(candidate.maxScore, 0, 1, 0),
      hitCount: candidate.sampleCount
    })),
    previewWords: Array.isArray(top.previewWords) ? top.previewWords.slice(0, 24) : [],
    message: buildPreviewDetectionMessage(top, confidence, top.sampleCount)
  };
}

module.exports = {
  detectVerseRangeFromWords,
  detectVerseRangeFromPreviewSamples
};
