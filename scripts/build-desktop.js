const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { rcedit } = require("rcedit");

const rootDir = path.join(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const unpackedDir = path.join(distDir, "win-unpacked");
const appExePath = path.join(unpackedDir, "QuranVideoMaker.exe");
const iconPath = path.join(rootDir, "logo-build.ico");
const builderCli = path.join(rootDir, "node_modules", "electron-builder", "cli.js");

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      ...extraEnv
    }
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function cleanDist() {
  if (!fs.existsSync(distDir)) return;
  fs.rmSync(distDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200
  });
}

async function patchAppExecutableIcon() {
  if (!fs.existsSync(appExePath)) {
    throw new Error(`Executable introuvable a patcher: ${appExePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Icone introuvable: ${iconPath}`);
  }
  await rcedit(appExePath, {
    icon: iconPath,
    "version-string": {
      ProductName: "Quran Video Maker",
      FileDescription: "Quran Video Maker",
      InternalName: "QuranVideoMaker",
      OriginalFilename: "QuranVideoMaker.exe"
    }
  });
}

function removeLegacyArtifacts() {
  const legacyNames = [
    "QuranVideoMaker 1.0.0.exe",
    "QuranVideoMaker.exe"
  ];
  for (const name of legacyNames) {
    const target = path.join(distDir, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const installerOnly = args.includes("--installer-only");
  const portableOnly = args.includes("--portable-only");

  cleanDist();

  run(process.execPath, [path.join(rootDir, "scripts", "prepare-desktop-runtime.js")]);
  run(process.execPath, [builderCli, "--win", "dir"]);
  await patchAppExecutableIcon();

  const targets = [];
  if (!portableOnly) targets.push("nsis");
  if (!installerOnly) targets.push("portable");
  if (targets.length === 0) {
    targets.push("nsis", "portable");
  }

  run(process.execPath, [builderCli, "--win", ...targets, "--prepackaged", unpackedDir]);
  removeLegacyArtifacts();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
