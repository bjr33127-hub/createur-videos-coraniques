const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = process.cwd();
const stageRoot = path.join(rootDir, ".build", "runtime");
const stagePythonDir = path.join(stageRoot, "python");
const stageFfmpegDir = path.join(stageRoot, "ffmpeg");
const stageImportDir = path.join(stageRoot, "personalized_import");

function removeWithRetries(targetPath) {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200
  });
}

function ensureCleanDirectory(targetPath) {
  removeWithRetries(targetPath);
  fs.mkdirSync(targetPath, { recursive: true });
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function dedupe(values) {
  const output = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || output.includes(normalized)) continue;
    output.push(normalized);
  }
  return output;
}

function runLocator(commandName) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = spawnSync(locator, [commandName], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error) return [];
    const stdout = String(result.stdout || "");
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function getPathCandidates(fileName) {
  const pathValue = String(process.env.PATH || "");
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.join(entry, fileName))
    .filter((candidate) => fs.existsSync(candidate));
}

function listPythonInstallDirs() {
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  if (!localAppData) return [];
  const baseDir = path.join(localAppData, "Programs", "Python");
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Python\d+/i.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true, sensitivity: "base" }));
  return entries.map((entry) => path.join(baseDir, entry.name));
}

function isUsablePythonDir(dirPath) {
  if (!dirPath) return false;
  const executableName = process.platform === "win32" ? "python.exe" : "python3";
  return fs.existsSync(path.join(dirPath, executableName)) && fs.existsSync(path.join(dirPath, "Lib"));
}

function resolvePythonSourceDir() {
  const candidates = [];
  const envSourceDir = String(process.env.QVM_PYTHON_SOURCE_DIR || "").trim();
  if (envSourceDir) {
    candidates.push(envSourceDir);
  }

  const envPythonBin = String(process.env.QVM_PYTHON_BIN || "").trim();
  if (envPythonBin) {
    candidates.push(path.dirname(envPythonBin));
  }

  const discoveredBins = [
    ...runLocator("python"),
    ...runLocator("python3"),
    ...getPathCandidates(process.platform === "win32" ? "python.exe" : "python3")
  ];

  for (const binaryPath of discoveredBins) {
    const normalized = normalizeSlashes(binaryPath).toLowerCase();
    if (normalized.includes("/windowsapps/python.exe")) continue;
    candidates.push(path.dirname(binaryPath));
  }

  candidates.push(...listPythonInstallDirs());

  const uniqueCandidates = dedupe(candidates);
  const resolved = uniqueCandidates.find(isUsablePythonDir);
  if (resolved) {
    return resolved;
  }

  throw new Error(
    "Impossible de preparer le runtime Python embarque. " +
    "Installe Python 3, ou definis QVM_PYTHON_SOURCE_DIR / QVM_PYTHON_BIN avant npm run build."
  );
}

function isUsableFfmpegDir(dirPath) {
  if (!dirPath) return false;
  const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return fs.existsSync(path.join(dirPath, ffmpegName)) && fs.existsSync(path.join(dirPath, ffprobeName));
}

function resolveFfmpegSourceDir() {
  const candidates = [];
  const envSourceDir = String(process.env.QVM_FFMPEG_SOURCE_DIR || "").trim();
  if (envSourceDir) {
    candidates.push(envSourceDir);
  }

  const envFfmpegBin = String(process.env.FFMPEG_BIN || "").trim();
  if (envFfmpegBin) {
    candidates.push(path.dirname(envFfmpegBin));
  }

  const discoveredBins = [
    ...runLocator("ffmpeg"),
    ...getPathCandidates(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
  ];

  for (const binaryPath of discoveredBins) {
    candidates.push(path.dirname(binaryPath));
  }

  const uniqueCandidates = dedupe(candidates);
  const resolved = uniqueCandidates.find(isUsableFfmpegDir);
  if (resolved) {
    return resolved;
  }

  throw new Error(
    "Impossible de preparer le runtime ffmpeg embarque. " +
    "Installe ffmpeg, ou definis QVM_FFMPEG_SOURCE_DIR / FFMPEG_BIN avant npm run build."
  );
}

function shouldCopyPythonEntry(sourcePath, destinationPath) {
  const relativePath = path.relative(destinationPath.sourceRoot, sourcePath);
  const normalized = normalizeSlashes(relativePath);
  if (!normalized || normalized === ".") return true;

  const skipPrefixes = [
    "Doc/",
    "Tools/",
    "include/",
    "Scripts/",
    "share/",
    "tcl/",
    "Lib/site-packages/",
    "Lib/test/",
    "Lib/venv/",
    "Lib/ensurepip/",
    "Lib/curses/",
    "Lib/tkinter/",
    "Lib/tkinter/test/",
    "Lib/idlelib/",
    "Lib/turtledemo/",
    "__pycache__/",
    "Lib/__pycache__/",
    "DLLs/__pycache__/"
  ];

  const skipFiles = new Set([
    "pythonw.exe",
    "NEWS.txt",
    "DLLs/tcl86t.dll",
    "DLLs/tk86t.dll",
    "DLLs/_tkinter.pyd",
    "libs/_tkinter.lib"
  ]);

  if (skipFiles.has(normalized)) {
    return false;
  }

  return !skipPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function copyDirectoryRecursive(sourceRoot, destinationRoot, filterFn = null) {
  fs.cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    filter: filterFn
      ? (sourcePath) => filterFn(sourcePath, { sourceRoot, destinationRoot })
      : undefined
  });
}

function copyRuntimeScript() {
  const sourceScriptPath = path.join(rootDir, "electron", "personalized_import", "offline_import.py");
  if (!fs.existsSync(sourceScriptPath)) {
    throw new Error(`Script Python introuvable: ${sourceScriptPath}`);
  }
  ensureDirectory(stageImportDir);
  fs.copyFileSync(sourceScriptPath, path.join(stageImportDir, "offline_import.py"));
}

function copyFfmpegRuntime(sourceDir, destinationDir) {
  ensureDirectory(destinationDir);
  const executableNames = process.platform === "win32"
    ? ["ffmpeg.exe", "ffprobe.exe"]
    : ["ffmpeg", "ffprobe"];
  for (const executableName of executableNames) {
    const sourcePath = path.join(sourceDir, executableName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Binaire ffmpeg manquant: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(destinationDir, executableName));
  }
}

function writeRuntimeManifest(pythonSourceDir, ffmpegSourceDir) {
  const manifestPath = path.join(stageRoot, "runtime-manifest.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    pythonSourceDir,
    ffmpegSourceDir
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), "utf8");
}

function main() {
  ensureCleanDirectory(stageRoot);

  const pythonSourceDir = resolvePythonSourceDir();
  const ffmpegSourceDir = resolveFfmpegSourceDir();

  copyDirectoryRecursive(pythonSourceDir, stagePythonDir, shouldCopyPythonEntry);
  copyFfmpegRuntime(ffmpegSourceDir, stageFfmpegDir);
  copyRuntimeScript();
  writeRuntimeManifest(pythonSourceDir, ffmpegSourceDir);

  console.log(`Bundled Python runtime from ${pythonSourceDir}`);
  console.log(`Bundled ffmpeg runtime from ${ffmpegSourceDir}`);
  console.log(`Desktop runtime ready in ${stageRoot}`);
}

main();
