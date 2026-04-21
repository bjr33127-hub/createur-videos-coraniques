const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { detectVerseRangeFromWords } = require("./quran-verse-search");

const MAX_PERSONALIZED_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_PERSONALIZED_SLICING = Object.freeze({
  leadPadMs: 35,
  tailPadMs: 320
});

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function toIsoNow() {
  return new Date().toISOString();
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function basenameLower(value) {
  return path.basename(String(value || "")).toLowerCase();
}

function parseSimpleEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function sanitizeDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").slice(0, 120);
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeSlicing(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    leadPadMs: clampNumber(src.leadPadMs, 0, 1000, DEFAULT_PERSONALIZED_SLICING.leadPadMs),
    tailPadMs: clampNumber(src.tailPadMs, 0, 2000, DEFAULT_PERSONALIZED_SLICING.tailPadMs)
  };
}

function randomId(prefix = "") {
  return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeSummary(summary) {
  const src = summary && typeof summary === "object" ? summary : {};
  return {
    backend: String(src.backend || "unknown"),
    durationSec: Number(src.durationSec || 0),
    matchedWords: Number(src.matchedWords || 0),
    totalWords: Number(src.totalWords || 0),
    coverageRatio: Number(src.coverageRatio || 0),
    matchedAyahs: Number(src.matchedAyahs || 0),
    totalAyahs: Number(src.totalAyahs || 0),
    averageConfidence: Number(src.averageConfidence || 0),
    generatedAt: String(src.generatedAt || "")
  };
}

function normalizeImportMetadata(importId, raw, importDir) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(src.id || importId),
    name: sanitizeDisplayName(src.name) || `Recitation personnalisee ${importId}`,
    type: "personalized",
    formatVersion: Number(src.formatVersion || 1),
    surah: Number(src.surah || 0),
    startAyah: Number(src.startAyah || 0),
    endAyah: Number(src.endAyah || 0),
    sourceAudioPath: String(src.sourceAudioPath || ""),
    sourceAudioUrl: String(src.sourceAudioUrl || `/api/personalized/source?id=${encodeURIComponent(String(src.id || importId))}`),
    manifestPath: String(src.manifestPath || `/user-assets/personalized/${importId}/manifest.json`),
    manifestFilePath: String(src.manifestFilePath || path.join(importDir, "manifest.json")),
    status: String(src.status || "ready"),
    slicing: normalizeSlicing(src.slicing),
    analysisSummary: normalizeSummary(src.analysisSummary),
    createdAt: String(src.createdAt || toIsoNow()),
    updatedAt: String(src.updatedAt || src.createdAt || toIsoNow())
  };
}

class PersonalizedReciterManager {
  constructor({ app, scriptPath, runtimeDir = "" }) {
    this.app = app;
    this.scriptPath = scriptPath;
    this.runtimeDir = String(runtimeDir || "");
    this.projectRoot = path.join(__dirname, "..");
    this.rootDir = path.join(app.getPath("userData"), "personalized_reciters");
    this.userDataDir = app.getPath("userData");
    this.importsDir = path.join(this.rootDir, "imports");
    this.detectionCacheFile = path.join(this.rootDir, "detection_cache.json");
    this.imports = new Map();
    this.jobs = new Map();
    this.detectionCache = new Map();
    this.pythonPathPromise = null;
    this.ffmpegPathsPromise = null;
    ensureDirSync(this.rootDir);
    ensureDirSync(this.importsDir);
  }

  async init() {
    await this.loadDetectionCache();
    await this.reloadImports();
  }

  listImports() {
    return Array.from(this.imports.values()).sort((a, b) => {
      const bySurah = Number(a.surah || 0) - Number(b.surah || 0);
      if (bySurah !== 0) return bySurah;
      return String(a.name || "").localeCompare(String(b.name || ""), "fr", { sensitivity: "base" });
    });
  }

  getJobStatus(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    return job ? this.serializeJob(job) : null;
  }

  getImportsDir() {
    return this.importsDir;
  }

  buildDetectionCacheKey(filePath, stat) {
    return JSON.stringify({
      path: String(filePath || ""),
      sizeBytes: Number(stat?.size || 0),
      mtimeMs: Number(stat?.mtimeMs || 0)
    });
  }

  async loadDetectionCache() {
    this.detectionCache = new Map();
    if (!fs.existsSync(this.detectionCacheFile)) return this.detectionCache;
    try {
      const payload = JSON.parse(await fsp.readFile(this.detectionCacheFile, "utf8"));
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      for (const entry of entries) {
        const key = String(entry?.key || "");
        if (!key || !entry?.result || typeof entry.result !== "object") continue;
        this.detectionCache.set(key, {
          result: {
            surah: Number(entry.result.surah || 0),
            confidence: Number(entry.result.confidence || 0),
            startAyah: Number(entry.result.startAyah || 0),
            endAyah: Number(entry.result.endAyah || 0),
            topCandidates: Array.isArray(entry.result.topCandidates) ? entry.result.topCandidates : [],
            previewWords: Array.isArray(entry.result.previewWords) ? entry.result.previewWords : [],
            message: String(entry.result.message || "")
          },
          updatedAt: String(entry.updatedAt || "")
        });
      }
    } catch (_) {
      this.detectionCache = new Map();
    }
    return this.detectionCache;
  }

  async persistDetectionCache() {
    const entries = Array.from(this.detectionCache.entries())
      .slice(-200)
      .map(([key, entry]) => ({
        key,
        updatedAt: String(entry?.updatedAt || toIsoNow()),
        result: {
          surah: Number(entry?.result?.surah || 0),
          confidence: Number(entry?.result?.confidence || 0),
          startAyah: Number(entry?.result?.startAyah || 0),
          endAyah: Number(entry?.result?.endAyah || 0),
          topCandidates: Array.isArray(entry?.result?.topCandidates) ? entry.result.topCandidates : [],
          previewWords: Array.isArray(entry?.result?.previewWords) ? entry.result.previewWords : [],
          message: String(entry?.result?.message || "")
        }
      }));
    await fsp.writeFile(
      this.detectionCacheFile,
      JSON.stringify({ version: 1, updatedAt: toIsoNow(), entries }, null, 2),
      "utf8"
    );
  }

  async reloadImports() {
    ensureDirSync(this.importsDir);
    const entries = await fsp.readdir(this.importsDir, { withFileTypes: true }).catch(() => []);
    const nextImports = new Map();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const importId = entry.name;
      const importDir = path.join(this.importsDir, importId);
      const metaPath = path.join(importDir, "metadata.json");
      try {
        const raw = JSON.parse(await fsp.readFile(metaPath, "utf8"));
        const metadata = normalizeImportMetadata(importId, raw, importDir);
        if (!fs.existsSync(metadata.manifestFilePath)) continue;
        nextImports.set(importId, metadata);
      } catch (_) {
        continue;
      }
    }
    this.imports = nextImports;
    return this.listImports();
  }

  async deleteImport(importId) {
    const normalizedId = String(importId || "").trim();
    if (!normalizedId) {
      throw new Error("Import introuvable.");
    }
    for (const job of this.jobs.values()) {
      if (job.importId === normalizedId && (job.status === "queued" || job.status === "running")) {
        throw new Error("Une analyse est encore en cours pour cet import.");
      }
    }
    const targetDir = path.join(this.importsDir, normalizedId);
    if (!fs.existsSync(targetDir)) {
      this.imports.delete(normalizedId);
      return { ok: true, imports: this.listImports() };
    }
    await fsp.rm(targetDir, { recursive: true, force: true });
    this.imports.delete(normalizedId);
    return { ok: true, imports: this.listImports() };
  }

  resolveAssetPath(urlPath) {
    const rawPath = decodeURIComponent(String(urlPath || "").split("?")[0]);
    if (!rawPath.startsWith("/user-assets/personalized/")) return null;
    const suffix = rawPath.slice("/user-assets/personalized/".length);
    const parts = suffix.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const importId = parts.shift();
    const importDir = path.join(this.importsDir, importId);
    const resolved = path.normalize(path.join(importDir, ...parts));
    if (!resolved.startsWith(importDir)) return null;
    return resolved;
  }

  createJob({ importId, filePath, surah, startAyah, displayName, message }) {
    const jobId = randomId("job_");
    const job = {
      jobId,
      importId,
      filePath: String(filePath || ""),
      surah: Number(surah || 0),
      startAyah: Number(startAyah || 0),
      displayName: sanitizeDisplayName(displayName) || "Recitation personnalisee",
      status: "queued",
      stage: "queued",
      progress: 0,
      message: String(message || "En attente du sidecar Python..."),
      logs: [],
      error: "",
      startedAt: toIsoNow(),
      finishedAt: "",
      metadata: null
    };
    this.jobs.set(jobId, job);
    return job;
  }

  async runImportJob({
    importId,
    importDir,
    filePath,
    surah,
    startAyah,
    displayName,
    slicing,
    rebuildOnly = false,
    queuedMessage,
    bootMessage,
    completedMessage
  }) {
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`Script Python introuvable: ${this.scriptPath}`);
    }

    const normalizedSlicing = normalizeSlicing(slicing);
    const [pythonRuntime, ffmpegTools] = await Promise.all([
      this.resolvePythonPath(),
      this.resolveFfmpegTools()
    ]);

    ensureDirSync(importDir);
    const job = this.createJob({
      importId,
      filePath,
      surah,
      startAyah,
      displayName,
      message: queuedMessage || "En attente du sidecar Python..."
    });

    const args = [
      "-u",
      this.scriptPath,
      "--audio-file",
      String(filePath),
      "--surah",
      String(surah),
      "--start-ayah",
      String(Math.max(1, Number(startAyah || 1))),
      "--display-name",
      String(displayName),
      "--import-id",
      String(importId),
      "--output-dir",
      String(importDir),
      "--lead-pad-ms",
      String(normalizedSlicing.leadPadMs),
      "--tail-pad-ms",
      String(normalizedSlicing.tailPadMs)
    ];
    if (rebuildOnly) {
      args.push("--rebuild-only");
    }

    const env = {
      ...process.env,
      ...this.loadProjectEnv(),
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      FFMPEG_BIN: ffmpegTools.ffmpeg,
      FFPROBE_BIN: ffmpegTools.ffprobe
    };

    let child = null;
    try {
      child = spawn(pythonRuntime.command, [...pythonRuntime.args, ...args], {
        cwd: path.dirname(this.scriptPath),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      job.status = "failed";
      job.stage = "spawn_failed";
      job.error = this.formatSpawnFailure(error, pythonRuntime.command, "Python");
      job.message = job.error;
      job.finishedAt = toIsoNow();
      return job;
    }

    job.child = child;
    job.status = "running";
    job.stage = "boot";
    job.message = String(bootMessage || "Initialisation de l'analyse...");

    const onLine = (line, isError = false) => {
      if (!line) return;
      const trimmed = String(line).trim();
      if (!trimmed) return;
      if (job.logs.length >= 30) job.logs.shift();
      job.logs.push(trimmed);

      try {
        const payload = JSON.parse(trimmed);
        this.applyJobEvent(job, payload);
      } catch (_) {
        if (isError) {
          job.message = trimmed;
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) onLine(line, false);
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) onLine(line, true);
    });

    child.once("error", (error) => {
      job.status = "failed";
      job.stage = "spawn_failed";
      job.error = this.formatSpawnFailure(error, pythonRuntime.command, "Python");
      job.message = job.error;
      job.finishedAt = toIsoNow();
    });

    child.once("close", async (code) => {
      if (stdoutBuffer.trim()) onLine(stdoutBuffer, false);
      if (stderrBuffer.trim()) onLine(stderrBuffer, true);

      if (code === 0 && job.status !== "failed") {
        try {
          const metadata = await this.loadImportMetadata(importId);
          job.status = "completed";
          job.stage = "completed";
          job.progress = 1;
          job.message = String(completedMessage || "Import termine.");
          job.metadata = metadata;
          job.finishedAt = toIsoNow();
          this.imports.set(importId, metadata);
        } catch (error) {
          job.status = "failed";
          job.stage = "metadata_error";
          job.error = error instanceof Error ? error.message : String(error);
          job.message = job.error;
          job.finishedAt = toIsoNow();
        }
      } else if (job.status !== "failed") {
        job.status = "failed";
        job.stage = "failed";
        job.error = job.error || job.message || `Le sidecar Python a quitte avec le code ${code}.`;
        job.message = job.error;
        job.finishedAt = toIsoNow();
      }

      delete job.child;
      if (job.status === "failed") {
        const metaPath = path.join(importDir, "metadata.json");
        if (!fs.existsSync(metaPath)) {
          await fsp.rm(importDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    });

    return job;
  }

  async startImport({ filePath, surah, startAyah, displayName }) {
    const normalizedFilePath = String(filePath || "").trim();
    const normalizedSurah = Number(surah || 0);
    const normalizedStartAyah = Math.max(1, Number(startAyah || 1));
    const normalizedName = sanitizeDisplayName(displayName) || path.parse(normalizedFilePath).name || "Recitation personnalisee";

    if (!normalizedFilePath || !fs.existsSync(normalizedFilePath)) {
      throw new Error("Fichier audio introuvable.");
    }
    if (!Number.isFinite(normalizedSurah) || normalizedSurah < 1 || normalizedSurah > 114) {
      throw new Error("Sourate invalide.");
    }

    const fileStat = await fsp.stat(normalizedFilePath);
    if (!fileStat.isFile()) {
      throw new Error("Le fichier audio selectionne est invalide.");
    }
    if (fileStat.size > MAX_PERSONALIZED_AUDIO_BYTES) {
      throw new Error("Le fichier depasse la limite de 25 Mo pour l'import personnalise.");
    }

    const importId = randomId("imp_");
    const importDir = path.join(this.importsDir, importId);
    const job = await this.runImportJob({
      importId,
      importDir,
      filePath: normalizedFilePath,
      surah: normalizedSurah,
      startAyah: normalizedStartAyah,
      displayName: normalizedName,
      slicing: DEFAULT_PERSONALIZED_SLICING,
      queuedMessage: "En attente du sidecar Python...",
      bootMessage: "Initialisation de l'analyse...",
      completedMessage: "Import termine."
    });

    return this.serializeJob(job);
  }

  async detectSurah({ filePath }) {
    const normalizedFilePath = String(filePath || "").trim();
    if (!normalizedFilePath || !fs.existsSync(normalizedFilePath)) {
      throw new Error("Fichier audio introuvable.");
    }

    const fileStat = await fsp.stat(normalizedFilePath);
    if (!fileStat.isFile()) {
      throw new Error("Le fichier audio selectionne est invalide.");
    }
    if (fileStat.size > MAX_PERSONALIZED_AUDIO_BYTES) {
      throw new Error("Le fichier depasse la limite de 25 Mo pour l'import personnalise.");
    }
    const cacheKey = this.buildDetectionCacheKey(normalizedFilePath, fileStat);
    const cachedDetection = this.detectionCache.get(cacheKey);
    if (cachedDetection?.result?.surah > 0) {
      return {
        surah: Number(cachedDetection.result.surah || 0),
        confidence: Number(cachedDetection.result.confidence || 0),
        startAyah: Number(cachedDetection.result.startAyah || 0),
        endAyah: Number(cachedDetection.result.endAyah || 0),
        topCandidates: Array.isArray(cachedDetection.result.topCandidates) ? cachedDetection.result.topCandidates : [],
        previewWords: Array.isArray(cachedDetection.result.previewWords) ? cachedDetection.result.previewWords : [],
        message: String(cachedDetection.result.message || "Sourate detectee.")
      };
    }

    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`Script Python introuvable: ${this.scriptPath}`);
    }

    const [pythonRuntime, ffmpegTools] = await Promise.all([
      this.resolvePythonPath(),
      this.resolveFfmpegTools()
    ]);

    const env = {
      ...process.env,
      ...this.loadProjectEnv(),
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      FFMPEG_BIN: ffmpegTools.ffmpeg,
      FFPROBE_BIN: ffmpegTools.ffprobe
    };

    const args = [
      "-u",
      this.scriptPath,
      "--audio-file",
      normalizedFilePath,
      "--transcribe-preview-only"
    ];

    let child = null;
    try {
      child = spawn(pythonRuntime.command, [...pythonRuntime.args, ...args], {
        cwd: path.dirname(this.scriptPath),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      throw new Error(this.formatSpawnFailure(error, pythonRuntime.command, "Python"));
    }

    const payload = await new Promise((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let finalPayload = null;
      let errorPayload = null;
      let lastProgressMessage = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch (_) {}
        reject(new Error("Auto-detection trop lente. Essaie un extrait plus net ou relance l'analyse."));
      }, 45000);

      const onStdoutLine = (line) => {
        const trimmed = String(line || "").trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (String(parsed?.type || "") === "complete") {
            finalPayload = parsed;
            if (String(parsed?.message || "").trim()) {
              lastProgressMessage = String(parsed.message).trim();
            }
          } else if (String(parsed?.type || "") === "error") {
            errorPayload = parsed;
          } else if (String(parsed?.type || "") === "progress") {
            if (String(parsed?.message || "").trim()) {
              lastProgressMessage = String(parsed.message).trim();
            }
          }
        } catch (_) {
          // Ignore non-JSON lines.
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) onStdoutLine(line);
      });

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(this.formatSpawnFailure(error, pythonRuntime.command, "Python")));
      });

      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (stdoutBuffer.trim()) onStdoutLine(stdoutBuffer);
        if (code !== 0) {
          const errorMessage = (
            String(errorPayload?.message || "").trim()
            || stderrBuffer.trim()
            || lastProgressMessage
            || `Detection echouee (code ${code}).`
          );
          reject(new Error(errorMessage));
          return;
        }
        if (!finalPayload) {
          reject(new Error("Detection de sourate invalide."));
          return;
        }
        resolve(finalPayload);
      });
    });

    const previewWords = Array.isArray(payload?.previewWords) ? payload.previewWords : [];
    if (previewWords.length < 2) {
      throw new Error("Pas assez de mots reconnus pour detecter la sourate.");
    }

    const verseDetection = await detectVerseRangeFromWords(previewWords);
    const detection = {
      surah: Number(verseDetection?.surah || 0),
      confidence: Number(verseDetection?.confidence || 0),
      startAyah: Number(verseDetection?.startAyah || 0),
      endAyah: Number(verseDetection?.endAyah || 0),
      topCandidates: Array.isArray(verseDetection?.topCandidates) ? verseDetection.topCandidates : [],
      previewWords,
      message: String(verseDetection?.message || "Sourate detectee.")
    };

    this.detectionCache.set(cacheKey, {
      result: detection,
      updatedAt: toIsoNow()
    });
    this.persistDetectionCache().catch(() => {});

    return detection;
  }

  async updateImportSettings({ id, displayName, leadPadMs, tailPadMs }) {
    const importId = String(id || "").trim();
    if (!importId) {
      throw new Error("Import introuvable.");
    }

    const importDir = path.join(this.importsDir, importId);
    const metadata = await this.loadImportMetadata(importId);
    if (!metadata?.sourceAudioPath || !fs.existsSync(metadata.sourceAudioPath)) {
      throw new Error("Le fichier source de cet import est introuvable.");
    }

    for (const job of this.jobs.values()) {
      if (job.importId === importId && (job.status === "queued" || job.status === "running")) {
        throw new Error("Une analyse ou une retouche est deja en cours pour cet import.");
      }
    }

    const job = await this.runImportJob({
      importId,
      importDir,
      filePath: metadata.sourceAudioPath,
      surah: metadata.surah,
      startAyah: metadata.startAyah,
      displayName: sanitizeDisplayName(displayName) || metadata.name,
      slicing: {
        leadPadMs,
        tailPadMs
      },
      rebuildOnly: true,
      queuedMessage: "Retouche de la decoupe en attente...",
      bootMessage: "Reconstruction du manifest personnalise...",
      completedMessage: "Decoupe personnalisee mise a jour."
    });

    return this.serializeJob(job);
  }

  applyJobEvent(job, payload) {
    if (!payload || typeof payload !== "object") return;
    const type = String(payload.type || "");
    if (type === "progress") {
      job.stage = String(payload.stage || job.stage || "running");
      job.message = String(payload.message || job.message || "");
      if (Number.isFinite(Number(payload.progress))) {
        job.progress = Math.max(0, Math.min(1, Number(payload.progress)));
      }
      return;
    }
    if (type === "error") {
      job.status = "failed";
      job.stage = String(payload.stage || "failed");
      job.error = String(payload.message || "Erreur inconnue.");
      job.message = job.error;
      job.finishedAt = toIsoNow();
      return;
    }
    if (type === "complete") {
      job.stage = "complete";
      job.progress = 1;
      job.message = String(payload.message || "Analyse terminee.");
    }
  }

  serializeJob(job) {
    return {
      jobId: job.jobId,
      importId: job.importId,
      surah: job.surah,
      startAyah: Number(job.startAyah || 0),
      displayName: job.displayName,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message,
      error: job.error,
      logs: job.logs.slice(-10),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      metadata: job.metadata
    };
  }

  async loadImportMetadata(importId) {
    const importDir = path.join(this.importsDir, importId);
    const metaPath = path.join(importDir, "metadata.json");
    const raw = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    return normalizeImportMetadata(importId, raw, importDir);
  }

  async resolvePythonPath() {
    if (!this.pythonPathPromise) {
      this.pythonPathPromise = this.resolvePythonRuntime().catch((error) => {
        this.pythonPathPromise = null;
        throw error;
      });
    }
    return this.pythonPathPromise;
  }

  async resolvePythonRuntime() {
    const attempted = [];
    const bundledRuntime = this.resolveBundledPythonRuntime();
    if (bundledRuntime) {
      const probe = await this.probeExecutable(bundledRuntime.command, [...bundledRuntime.args, "-V"]);
      if (probe.ok) {
        return bundledRuntime;
      }
      attempted.push({
        command: bundledRuntime.command,
        reason: probe.message || "Runtime Python embarque inutilisable."
      });
    }

    const envValue = String(this.loadProjectEnv().QVM_PYTHON_BIN || process.env.QVM_PYTHON_BIN || "").trim();
    const directCandidates = [];
    if (envValue) {
      directCandidates.push(envValue);
    }
    const discoveredCandidates = await this.findExecutableCandidates(
      ["python", "python3", "py"],
      (value) => !normalizeSlashes(value).includes("/windowsapps/python.exe")
    );
    for (const candidate of discoveredCandidates) {
      if (!directCandidates.includes(candidate)) {
        directCandidates.push(candidate);
      }
    }

    for (const candidate of directCandidates) {
      const runtime = this.buildPythonRuntimeCandidate(candidate);
      if (!runtime) continue;
      const probe = await this.probeExecutable(runtime.command, [...runtime.args, "-V"]);
      if (probe.ok) {
        return runtime;
      }
      attempted.push({
        command: runtime.command,
        reason: probe.message || "Executable Python inutilisable."
      });
    }

    const details = attempted.length
      ? ` Candidats testes: ${attempted.map((item) => `${item.command} (${item.reason})`).join(" ; ")}`
      : "";
    throw new Error(
      "Python introuvable ou inutilisable pour l'import personnalise. " +
      "Installe Python 3 depuis python.org, ou renseigne QVM_PYTHON_BIN vers un python.exe valide, puis relance l'application." +
      details
    );
  }

  loadProjectEnv() {
    const candidates = [
      path.join(this.rootDir, ".env"),
      path.join(this.rootDir, ".env.local"),
      path.join(this.userDataDir, ".env"),
      path.join(this.userDataDir, ".env.local"),
      path.join(this.userDataDir, "personalized_import", ".env"),
      path.join(this.userDataDir, "personalized_import", ".env.local"),
      path.join(this.projectRoot, ".env"),
      path.join(this.projectRoot, ".env.local"),
      path.join(path.dirname(this.scriptPath), ".env"),
      path.join(path.dirname(this.scriptPath), ".env.local")
    ];
    const merged = {};
    for (const candidate of candidates) {
      const parsed = parseSimpleEnvFile(candidate);
      for (const [key, value] of Object.entries(parsed)) {
        if (String(value || "").trim()) {
          merged[key] = value;
        }
      }
    }
    return merged;
  }

  async resolveFfmpegTools() {
    if (!this.ffmpegPathsPromise) {
      this.ffmpegPathsPromise = (async () => {
        const bundledTools = this.resolveBundledFfmpegTools();
        if (bundledTools) {
          return bundledTools;
        }
        const ffmpeg = await this.resolveExecutableFromEnv("FFMPEG_BIN", ["ffmpeg"]);
        const ffmpegDir = path.dirname(ffmpeg);
        const ffprobeCandidate = path.join(ffmpegDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
        if (fs.existsSync(ffprobeCandidate)) {
          return { ffmpeg, ffprobe: ffprobeCandidate };
        }
        const ffprobe = await this.resolveExecutableFromEnv("FFPROBE_BIN", ["ffprobe"]);
        return { ffmpeg, ffprobe };
      })();
    }
    return this.ffmpegPathsPromise;
  }

  resolveBundledPythonRuntime() {
    if (!this.runtimeDir) return null;
    const executableName = process.platform === "win32" ? "python.exe" : "python3";
    const bundledPython = path.join(this.runtimeDir, "python", executableName);
    if (!fs.existsSync(bundledPython)) {
      return null;
    }
    return {
      command: bundledPython,
      args: []
    };
  }

  resolveBundledFfmpegTools() {
    if (!this.runtimeDir) return null;
    const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    const ffmpeg = path.join(this.runtimeDir, "ffmpeg", ffmpegName);
    const ffprobe = path.join(this.runtimeDir, "ffmpeg", ffprobeName);
    if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
      return null;
    }
    return { ffmpeg, ffprobe };
  }

  buildPythonRuntimeCandidate(candidate) {
    const command = String(candidate || "").trim();
    if (!command) return null;
    const baseName = basenameLower(command);
    if (baseName === "py" || baseName === "py.exe") {
      return {
        command,
        args: process.platform === "win32" ? ["-3"] : []
      };
    }
    return { command, args: [] };
  }

  async findExecutableCandidates(commands, filterFn = null) {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const results = [];
    for (const command of commands) {
      const output = await new Promise((resolve) => {
        let child = null;
        try {
          child = spawn(locator, [command], {
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true
          });
        } catch (_) {
          resolve("");
          return;
        }
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
        });
        child.once("close", () => resolve(buffer));
        child.once("error", () => resolve(""));
      });
      const lines = String(output || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const filtered = typeof filterFn === "function" ? lines.filter(filterFn) : lines;
      for (const candidate of filtered) {
        if (!results.includes(candidate)) {
          results.push(candidate);
        }
      }
    }
    return results;
  }

  async probeExecutable(command, args = []) {
    return new Promise((resolve) => {
      let settled = false;
      let child = null;
      try {
        child = spawn(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        resolve({
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch (_) {}
        resolve({
          ok: false,
          message: "Aucune reponse du binaire."
        });
      }, 10000);

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(payload);
      };

      if (child.stdout) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
      }

      child.once("error", (error) => {
        finish({
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        });
      });

      child.once("close", (code) => {
        const stdioMessage = String(stderr || stdout).trim();
        finish({
          ok: code === 0,
          message: stdioMessage || `code ${code}`
        });
      });
    });
  }

  formatSpawnFailure(error, command, label = "Executable") {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const code = String(error?.code || "").trim().toUpperCase();
    if (code === "ENOENT") {
      return `${label} introuvable ou inaccessible: ${command}`;
    }
    if (code === "EACCES") {
      return `${label} trouve mais non executable: ${command}`;
    }
    return rawMessage || `${label} n'a pas pu etre lance: ${command}`;
  }

  async resolveExecutableFromEnv(envKey, commands, filterFn = null) {
    const envValue = String(this.loadProjectEnv()[envKey] || process.env[envKey] || "").trim();
    if (envValue && fs.existsSync(envValue)) {
      return envValue;
    }

    const locator = process.platform === "win32" ? "where.exe" : "which";
    for (const command of commands) {
      const resolved = await new Promise((resolve) => {
        let child = null;
        try {
          child = spawn(locator, [command], {
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true
          });
        } catch (_) {
          resolve("");
          return;
        }
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.once("close", () => {
          const lines = output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const filtered = typeof filterFn === "function" ? lines.filter(filterFn) : lines;
          resolve(filtered[0] || "");
        });
        child.once("error", () => resolve(""));
      });
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(`Executable introuvable pour ${envKey || commands.join(", ")}.`);
  }
}

module.exports = {
  PersonalizedReciterManager
};
