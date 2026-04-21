const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const { PersonalizedReciterManager } = require("./personalized-reciter-manager");

const APP_ROOT = path.join(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = 5500;
const DEFAULT_BATCH_CONFIG = {
  startSurah: 1,
  endSurah: 114,
  preRollMs: 1000,
  postRollMs: 1000,
  betweenSurahMs: 2000,
  loadTimeoutMs: 45000,
  playbackStartTimeoutMs: 15000,
  playbackEndTimeoutMs: 30 * 60 * 1000,
  retryCount: 2,
  obsUrl: "ws://127.0.0.1:4455",
  obsPassword: "",
  minRecordingBytes: 1024 * 100,
  settleMs: 1500
};
const STOP_REQUESTED_CODE = "BATCH_STOP_REQUESTED";

let mainWindow = null;
let localServer = null;
let playerReady = false;
let personalizedManager = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getPackagedRuntimeDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime");
  }
  const devRuntimeDir = path.join(APP_ROOT, ".build", "runtime");
  return fs.existsSync(devRuntimeDir) ? devRuntimeDir : "";
}

function getPersonalizedImportScriptPath() {
  const runtimeDir = getPackagedRuntimeDir();
  const packagedScriptPath = runtimeDir
    ? path.join(runtimeDir, "personalized_import", "offline_import.py")
    : "";
  if (packagedScriptPath && fs.existsSync(packagedScriptPath)) {
    return packagedScriptPath;
  }
  return path.join(__dirname, "personalized_import", "offline_import.py");
}

function sanitizeWindowsFileBaseName(value) {
  let sanitized = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!sanitized) {
    sanitized = "Enregistrement";
  }

  const reserved = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
  ]);
  if (reserved.has(sanitized.toUpperCase())) {
    sanitized = `${sanitized} fichier`;
  }

  return sanitized;
}

async function buildUniqueSiblingPath(filePath, desiredBaseName) {
  const parsed = path.parse(filePath);
  const baseName = sanitizeWindowsFileBaseName(desiredBaseName);
  const sourcePath = path.resolve(filePath);

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index + 1})`;
    const candidatePath = path.join(parsed.dir, `${baseName}${suffix}${parsed.ext}`);
    if (path.resolve(candidatePath) === sourcePath) {
      return candidatePath;
    }
    try {
      await fsp.access(candidatePath, fs.constants.F_OK);
    } catch (_) {
      return candidatePath;
    }
  }

  throw new Error("Impossible de trouver un nom de fichier disponible pour l'enregistrement OBS.");
}

function safeResolve(urlPath) {
  const pathname = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.normalize(path.join(APP_ROOT, requested));
  if (!resolved.startsWith(APP_ROOT)) return null;
  return resolved;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createStopRequestedError() {
  const error = new Error("Arret du batch demande.");
  error.code = STOP_REQUESTED_CODE;
  return error;
}

function isStopRequestedError(error) {
  return Boolean(error && typeof error === "object" && error.code === STOP_REQUESTED_CODE);
}

class ObsWebSocketClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.connectPromise = null;
    this.pending = new Map();
    this.requestId = 0;
  }

  async connect({ url, password }) {
    if (this.connected && this.ws && this.ws.readyState === 1) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.connected = false;
        this.ws = null;
        reject(error);
      };

      ws.addEventListener("error", () => {
        fail(new Error(`Impossible de joindre OBS via ${url}`));
      });

      ws.addEventListener("close", () => {
        this.connected = false;
        this.ws = null;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("Connexion OBS interrompue."));
        }
        this.pending.clear();
        if (!settled) {
          fail(new Error("Connexion OBS fermée avant identification."));
        }
      });

      ws.addEventListener("message", async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.op === 0) {
            const identify = { op: 1, d: { rpcVersion: 1 } };
            const auth = msg.d?.authentication;
            if (auth?.challenge && auth?.salt) {
              const secret = this.sha256Base64(String(password || "") + auth.salt);
              identify.d.authentication = this.sha256Base64(secret + auth.challenge);
            }
            ws.send(JSON.stringify(identify));
            return;
          }

          if (msg.op === 2) {
            settled = true;
            this.connected = true;
            resolve();
            return;
          }

          if (msg.op === 7) {
            const pending = this.pending.get(msg.d?.requestId);
            if (!pending) return;
            this.pending.delete(msg.d.requestId);
            if (msg.d?.requestStatus?.result) pending.resolve(msg.d.responseData || {});
            else pending.reject(new Error(msg.d?.requestStatus?.comment || "OBS request failed"));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        // noop
      }
    }
    this.connected = false;
    this.ws = null;
  }

  async request(type, requestData = {}) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) {
      throw new Error("OBS n'est pas connecté.");
    }

    const requestId = `req-${Date.now()}-${++this.requestId}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout OBS sur ${type}`));
      }, 15000);

      this.pending.set(requestId, {
        resolve: (payload) => {
          clearTimeout(timeoutId);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      this.ws.send(JSON.stringify({
        op: 6,
        d: { requestType: type, requestId, requestData }
      }));
    });
  }

  sha256Base64(input) {
    return crypto.createHash("sha256").update(input).digest("base64");
  }
}

class BatchOrchestrator {
  constructor() {
    this.obs = new ObsWebSocketClient();
    this.pendingEvents = [];
    this.playerState = {
      lastEventAt: 0,
      lastEvent: null,
      currentSurah: null,
      playbackStartedAt: 0
    };
    this.runtime = {
      status: "idle",
      error: null,
      config: null,
      currentSurah: null,
      currentAttempt: 0,
      completed: [],
      lastOutputPath: null,
      stopRequested: false
    };
    this.stateDir = path.join(app.getPath("userData"), "batch");
    this.stateFile = path.join(this.stateDir, "checkpoint.json");
    ensureDirSync(this.stateDir);
  }

  getStatus() {
    return {
      ...this.runtime,
      playerReady,
      playerState: this.playerState,
      stateFile: this.stateFile
    };
  }

  async loadCheckpoint() {
    try {
      const raw = await fsp.readFile(this.stateFile, "utf8");
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async saveCheckpoint(extra = {}) {
    const checkpoint = {
      savedAt: new Date().toISOString(),
      status: this.runtime.status,
      config: this.runtime.config,
      currentSurah: this.runtime.currentSurah,
      currentAttempt: this.runtime.currentAttempt,
      completed: this.runtime.completed,
      lastOutputPath: this.runtime.lastOutputPath,
      ...extra
    };
    await fsp.writeFile(this.stateFile, JSON.stringify(checkpoint, null, 2), "utf8");
  }

  handlePlayerEvent(event) {
    this.playerState.lastEventAt = Date.now();
    this.playerState.lastEvent = event;
    if (event.type === "surah_loaded") this.playerState.currentSurah = event.payload?.surah ?? null;
    if (event.type === "playback_started") this.playerState.playbackStartedAt = Date.now();

    const remaining = [];
    for (const pending of this.pendingEvents) {
      if (pending.matches(event)) {
        clearTimeout(pending.timeoutId);
        pending.settled = true;
        } else {
        remaining.push(pending);
      }
    }
    this.pendingEvents = remaining;
  }

  waitForPlayerEvent(type, predicate, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      const stopErrorFactory = options.stopErrorFactory || createStopRequestedError;
      const rejectOn = Array.isArray(options.rejectOn) ? options.rejectOn : [];
      const finalize = (handler) => (value) => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(timeoutId);
        this.pendingEvents = this.pendingEvents.filter((item) => item !== pending);
        handler(value);
      };

      const timeoutId = setTimeout(() => {
        if (pending.settled) return;
        pending.settled = true;
        this.pendingEvents = this.pendingEvents.filter((item) => item !== pending);
        reject(new Error(`Timeout en attente de ${type}`));
      }, timeoutMs);

      const pending = {
        timeoutId,
        settled: false,
        cancel: (error) => finalize(reject)(error),
        matches: (event) => {
          const payload = event.payload || {};
          if (event.type === type && (!predicate || predicate(payload))) {
            finalize(resolve)(payload);
            return true;
          }

          for (const rejectRule of rejectOn) {
            if (event.type !== rejectRule.type) continue;
            if (rejectRule.predicate && !rejectRule.predicate(payload)) continue;
            const errorFactory = rejectRule.errorFactory || ((matchedPayload) => new Error(`Evenement ${event.type} recu pendant l'attente de ${type}`));
            finalize(reject)(errorFactory(payload, event));
            return true;
          }

          return false;
        }
      };

      if (this.runtime.stopRequested) {
        pending.settled = true;
        clearTimeout(timeoutId);
        reject(stopErrorFactory());
        return;
      }

      this.pendingEvents.push(pending);
    });
  }

  cancelPendingPlayerEvents(reason = createStopRequestedError()) {
    const pending = this.pendingEvents.splice(0);
    for (const waiter of pending) {
      waiter.cancel(reason);
    }
  }

  throwIfStopRequested() {
    if (this.runtime.stopRequested) {
      throw createStopRequestedError();
    }
  }

  async sleepWithStopCheck(ms) {
    let remaining = Math.max(0, Number(ms) || 0);
    while (remaining > 0) {
      this.throwIfStopRequested();
      const chunk = Math.min(remaining, 200);
      await sleep(chunk);
      remaining -= chunk;
    }
    this.throwIfStopRequested();
  }

  async ensurePlayerControl() {
    if (!mainWindow) throw new Error("Fenetre principale indisponible.");
    if (!playerReady) throw new Error("Le lecteur n'est pas encore pret.");
  }

  async invokePlayer(command, args = []) {
    await this.ensurePlayerControl();

    if (command === "loadSurah") {
      const surahValue = JSON.stringify(String(args[0]));
      return mainWindow.webContents.executeJavaScript(`
        (() => {
          const el = document.getElementById("surah");
          if (!el) throw new Error("select surah introuvable");
          el.value = ${surahValue};
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })();
      `);
    }

    if (command === "startPlayback") {
      return mainWindow.webContents.executeJavaScript(`
        (() => {
          const btn = document.getElementById("play");
          if (!btn) throw new Error("bouton play introuvable");
          btn.click();
          return true;
        })();
      `);
    }

    if (command === "stopPlayback") {
      return mainWindow.webContents.executeJavaScript(`
        (() => {
          const audio = document.getElementById("audio");
          if (audio) audio.pause();
          return true;
        })();
      `);
    }

    throw new Error(`Commande lecteur inconnue: ${command}`);
  }

  async ensureObsReady() {
    const config = this.runtime.config;
    await this.obs.connect({ url: config.obsUrl, password: config.obsPassword });
    const status = await this.obs.request("GetRecordStatus");
    if (status.outputActive) {
      throw new Error("OBS enregistre deja. Arrete l'enregistrement avant de lancer le batch.");
    }
  }

  async startRecording() {
    this.throwIfStopRequested();
    await this.obs.request("StartRecord");
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      this.throwIfStopRequested();
      const status = await this.obs.request("GetRecordStatus");
      if (status.outputActive) {
        return status;
      }
      await this.sleepWithStopCheck(200);
    }
    throw new Error("OBS n'a pas confirme le demarrage de l'enregistrement.");
  }

  async stopRecordingIfActive(fallbackPath = null) {
    if (!this.obs.connected || !this.obs.ws || this.obs.ws.readyState !== 1) {
      return fallbackPath;
    }

    let status = null;
    try {
      status = await this.obs.request("GetRecordStatus");
    } catch (_) {
      return fallbackPath;
    }

    if (!status.outputActive) {
      return status.outputPath || fallbackPath;
    }

    try {
      const response = await this.obs.request("StopRecord");
      return response.outputPath || status.outputPath || fallbackPath;
    } catch (_) {
      return status.outputPath || fallbackPath;
    }
  }

  async stopRecordingAndVerify(fallbackPath = null) {
    let outputPath = fallbackPath;
    try {
      const response = await this.obs.request("StopRecord");
      outputPath = response.outputPath || outputPath;
    } catch (error) {
      throw new Error(`Impossible d'arreter OBS: ${toErrorMessage(error)}`);
    }

    await sleep(this.runtime.config.settleMs);

    if (!outputPath) {
      throw new Error("OBS n'a pas renvoye de fichier de sortie.");
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Fichier de sortie introuvable: ${outputPath}`);
    }

    const stat = fs.statSync(outputPath);
    if (stat.size < this.runtime.config.minRecordingBytes) {
      throw new Error(`Fichier de sortie trop petit: ${outputPath}`);
    }
    return outputPath;
  }

  async runSurah(surahNumber) {
    this.runtime.currentSurah = surahNumber;
    await this.saveCheckpoint();
    this.throwIfStopRequested();

    let recordPath = null;
    let recordingActive = false;

    try {
      await this.invokePlayer("loadSurah", [surahNumber]);
      await this.waitForPlayerEvent(
        "surah_loaded",
        (payload) => Number(payload.surah) === Number(surahNumber),
        this.runtime.config.loadTimeoutMs
      );

      await this.sleepWithStopCheck(this.runtime.config.preRollMs);

      const recordStatus = await this.startRecording();
      recordPath = recordStatus.outputPath || null;
      recordingActive = true;

      await this.invokePlayer("startPlayback");
      await this.waitForPlayerEvent(
        "playback_started",
        (payload) => Number(payload.surah) === Number(surahNumber),
        this.runtime.config.playbackStartTimeoutMs,
        {
          rejectOn: [
            {
              type: "playback_error",
              predicate: (payload) => Number(payload.surah) === Number(surahNumber),
              errorFactory: (payload) => new Error(
                `Erreur audio pendant le demarrage de la sourate ${surahNumber}: ${payload.mediaErrorMessage || payload.mediaErrorCode || "lecture impossible"}`
              )
            }
          ]
        }
      );

      await this.waitForPlayerEvent(
        "playback_ended",
        (payload) => Number(payload.surah) === Number(surahNumber),
        this.runtime.config.playbackEndTimeoutMs,
        {
          rejectOn: [
            {
              type: "playback_error",
              predicate: (payload) => Number(payload.surah) === Number(surahNumber),
              errorFactory: (payload) => new Error(
                `Erreur audio pendant la lecture de la sourate ${surahNumber}: ${payload.mediaErrorMessage || payload.mediaErrorCode || "lecture impossible"}`
              )
            }
          ]
        }
      );

      await this.sleepWithStopCheck(this.runtime.config.postRollMs);
      const outputPath = await this.stopRecordingAndVerify(recordPath);
      recordingActive = false;

      this.runtime.lastOutputPath = outputPath;
      this.runtime.completed = Array.from(new Set([...this.runtime.completed, surahNumber])).sort((a, b) => a - b);
      await this.saveCheckpoint({ lastCompletedSurah: surahNumber });
    } catch (error) {
      if (recordingActive) {
        await this.stopRecordingIfActive(recordPath);
        recordingActive = false;
      }
      throw error;
    }
  }

  async start(config = {}) {
    if (this.runtime.status === "running") {
      throw new Error("Un batch est deja en cours.");
    }

    const checkpoint = await this.loadCheckpoint();
    const merged = {
      ...DEFAULT_BATCH_CONFIG,
      ...(checkpoint?.config || {}),
      ...config
    };
    merged.startSurah = Math.max(1, Number(merged.startSurah || 1));
    merged.endSurah = Math.min(114, Number(merged.endSurah || 114));
    if (merged.endSurah < merged.startSurah) {
      throw new Error("endSurah doit etre superieur ou egal a startSurah.");
    }

    this.runtime = {
      status: "running",
      error: null,
      config: merged,
      currentSurah: checkpoint?.currentSurah || merged.startSurah,
      currentAttempt: 0,
      completed: Array.isArray(checkpoint?.completed) ? checkpoint.completed : [],
      lastOutputPath: checkpoint?.lastOutputPath || null,
      stopRequested: false
    };
    await this.saveCheckpoint();

    this.runLoop().catch(async (error) => {
      if (isStopRequestedError(error)) {
        this.runtime.status = "stopped";
        this.runtime.error = null;
        await this.saveCheckpoint({ stoppedAt: new Date().toISOString() });
        return;
      }
      this.runtime.status = "failed";
      this.runtime.error = toErrorMessage(error);
      await this.saveCheckpoint({ failedAt: new Date().toISOString() });
    });

    return this.getStatus();
  }

  async stop() {
    this.runtime.stopRequested = true;
    this.runtime.status = "stopping";
    this.cancelPendingPlayerEvents(createStopRequestedError());
    try {
      await this.invokePlayer("stopPlayback");
    } catch (_) {
      // noop
    }
    await this.stopRecordingIfActive(this.runtime.lastOutputPath || null);
    return this.getStatus();
  }

  async runLoop() {
    try {
      await this.ensureObsReady();
      await this.ensurePlayerControl();

      for (let surahNumber = this.runtime.currentSurah; surahNumber <= this.runtime.config.endSurah; surahNumber += 1) {
        if (this.runtime.stopRequested) {
          this.runtime.status = "stopped";
          await this.saveCheckpoint({ stoppedAt: new Date().toISOString() });
          return;
        }

        if (this.runtime.completed.includes(surahNumber)) {
          continue;
        }

        let attempt = 0;
        let success = false;
        while (attempt <= this.runtime.config.retryCount && !success) {
          attempt += 1;
          this.runtime.currentSurah = surahNumber;
          this.runtime.currentAttempt = attempt;
          await this.saveCheckpoint();

          try {
            await this.runSurah(surahNumber);
            success = true;
          } catch (error) {
            if (isStopRequestedError(error)) {
              throw error;
            }
            this.runtime.error = toErrorMessage(error);
            await this.saveCheckpoint({ lastError: this.runtime.error });
            if (attempt > this.runtime.config.retryCount) {
              throw new Error(`Sourate ${surahNumber} echouee apres ${attempt} tentative(s): ${this.runtime.error}`);
            }
            await this.sleepWithStopCheck(this.runtime.config.betweenSurahMs);
          }
        }

        if (surahNumber < this.runtime.config.endSurah) {
          await this.sleepWithStopCheck(this.runtime.config.betweenSurahMs);
        }
      }

      this.runtime.status = "completed";
      this.runtime.currentAttempt = 0;
      await this.saveCheckpoint({ completedAt: new Date().toISOString() });
    } finally {
      await this.obs.disconnect();
    }
  }
}

const orchestrator = new BatchOrchestrator();

async function handleApiRequest(req, res) {
  if (req.method === "GET" && req.url.startsWith("/api/personalized/source")) {
    try {
      if (!personalizedManager) throw new Error("Gestionnaire d'import non initialise.");
      const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
      const importId = String(parsed.searchParams.get("id") || "").trim();
      if (!importId) throw new Error("Import introuvable.");
      const metadata = await personalizedManager.loadImportMetadata(importId);
      if (!metadata?.sourceAudioPath || !fs.existsSync(metadata.sourceAudioPath)) {
        throw new Error("Le fichier source de cet import est introuvable.");
      }
      sendFile(res, metadata.sourceAudioPath);
    } catch (error) {
      sendJson(res, 404, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "GET" && req.url === "/api/personalized/imports") {
    try {
      const imports = personalizedManager ? await personalizedManager.reloadImports() : [];
      sendJson(res, 200, { ok: true, imports });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/personalized/import") {
    try {
      if (!personalizedManager) throw new Error("Gestionnaire d'import non initialise.");
      const body = await readJsonBody(req);
      const job = await personalizedManager.startImport(body || {});
      sendJson(res, 200, { ok: true, job });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/personalized/detect") {
    try {
      if (!personalizedManager) throw new Error("Gestionnaire d'import non initialise.");
      const body = await readJsonBody(req);
      const detection = await personalizedManager.detectSurah(body || {});
      sendJson(res, 200, { ok: true, detection });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/personalized/update") {
    try {
      if (!personalizedManager) throw new Error("Gestionnaire d'import non initialise.");
      const body = await readJsonBody(req);
      const job = await personalizedManager.updateImportSettings(body || {});
      sendJson(res, 200, { ok: true, job });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "GET" && req.url.startsWith("/api/personalized/status")) {
    try {
      if (!personalizedManager) throw new Error("Gestionnaire d'import non initialise.");
      const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
      const jobId = parsed.searchParams.get("jobId") || "";
      const job = personalizedManager.getJobStatus(jobId);
      if (!job) {
        sendJson(res, 404, { ok: false, error: "Job introuvable." });
      } else {
        sendJson(res, 200, { ok: true, job });
      }
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/personalized/delete") {
    try {
      if (!personalizedManager) throw new Error("Gestionnaire d'import non initialise.");
      const body = await readJsonBody(req);
      const payload = await personalizedManager.deleteImport(body?.id);
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "GET" && req.url === "/api/orchestrator/status") {
    sendJson(res, 200, orchestrator.getStatus());
    return true;
  }

  if (req.method === "POST" && req.url === "/api/orchestrator/start") {
    try {
      const body = await readJsonBody(req);
      const status = await orchestrator.start(body || {});
      sendJson(res, 200, status);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/orchestrator/stop") {
    try {
      const status = await orchestrator.stop();
      sendJson(res, 200, status);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/player-event") {
    try {
      const body = await readJsonBody(req);
      const { type, ...payload } = body || {};
      orchestrator.handlePlayerEvent({
        type,
        payload,
        at: Date.now()
      });
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: toErrorMessage(error) });
    }
    return true;
  }

  return false;
}

function sendFile(res, filePath) {
  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function startLocalServer() {
  if (localServer) return Promise.resolve();

  localServer = http.createServer(async (req, res) => {
    try {
      if (await handleApiRequest(req, res)) return;
    } catch (error) {
      sendJson(res, 500, { ok: false, error: toErrorMessage(error) });
      return;
    }

    const personalizedAsset = personalizedManager?.resolveAssetPath(req.url);
    if (personalizedAsset) {
      sendFile(res, personalizedAsset);
      return;
    }

    const filePath = safeResolve(req.url);
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    sendFile(res, filePath);
  });

  return new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(PORT, HOST, () => {
      localServer.removeListener("error", reject);
      resolve();
    });
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false
    }
  });

  mainWindow.loadURL(`http://${HOST}:${PORT}/`);
  mainWindow.webContents.on("did-finish-load", () => {
    playerReady = true;
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    playerReady = false;
  });
}

app.whenReady().then(async () => {
  const runtimeDir = getPackagedRuntimeDir();
  personalizedManager = new PersonalizedReciterManager({
    app,
    runtimeDir,
    scriptPath: getPersonalizedImportScriptPath()
  });
  await personalizedManager.init();

  ipcMain.handle("qvm:pick-personalized-audio", async () => {
    const response = await dialog.showOpenDialog({
      title: "Choisir une recitation complete",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["mp3", "wav", "m4a", "ogg", "webm", "flac", "aac"] },
        { name: "Tous les fichiers", extensions: ["*"] }
      ]
    });
    if (response.canceled || !response.filePaths?.length) {
      return { canceled: true, filePath: "", sizeBytes: 0 };
    }
    const filePath = response.filePaths[0];
    const sizeBytes = fs.existsSync(filePath) ? (fs.statSync(filePath).size || 0) : 0;
    return { canceled: false, filePath, sizeBytes };
  });

  ipcMain.handle("qvm:rename-recorded-file", async (_event, payload = {}) => {
    const rawFilePath = String(payload?.filePath || "").trim();
    const desiredBaseName = String(payload?.desiredBaseName || "").trim();
    if (!rawFilePath) {
      throw new Error("Fichier OBS introuvable pour le renommage.");
    }

    const sourcePath = path.resolve(rawFilePath);
    let sourceStat = null;
    try {
      sourceStat = await fsp.stat(sourcePath);
    } catch (_) {
      sourceStat = null;
    }
    if (!sourceStat?.isFile()) {
      throw new Error(`Fichier OBS introuvable: ${sourcePath}`);
    }

    const targetPath = await buildUniqueSiblingPath(sourcePath, desiredBaseName);
    if (path.resolve(targetPath) !== sourcePath) {
      await fsp.rename(sourcePath, targetPath);
    }

    return {
      ok: true,
      originalPath: sourcePath,
      filePath: targetPath,
      changed: path.resolve(targetPath) !== sourcePath
    };
  });

  await startLocalServer();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  try {
    await orchestrator.stop();
  } catch (_) {
    // noop
  }
  if (localServer) {
    localServer.close();
    localServer = null;
  }
});
