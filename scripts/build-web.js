const fs = require("fs");
const path = require("path");

const rootDir = process.cwd();
const outDir = path.join(rootDir, "web-dist");

const filesToCopy = [
  "index.html",
  "sw.js",
  "logo.png",
  "manifest.webmanifest",
  "_headers"
];

const dirsToCopy = [
  "qul",
  "icons"
];

function ensureExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing required path: ${targetPath}`);
  }
}

function copyItem(relativePath) {
  const sourcePath = path.join(rootDir, relativePath);
  const destinationPath = path.join(outDir, relativePath);
  ensureExists(sourcePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true
  });
}

function removeWithRetries(targetPath) {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200
  });
}

function emptyDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    removeWithRetries(entryPath);
  }
}

function ensureCleanOutputDir(targetPath) {
  try {
    removeWithRetries(targetPath);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EBUSY")) {
      fs.mkdirSync(targetPath, { recursive: true });
      emptyDirectory(targetPath);
    } else {
      throw error;
    }
  }
  fs.mkdirSync(targetPath, { recursive: true });
}

function main() {
  ensureCleanOutputDir(outDir);

  for (const relativePath of filesToCopy) {
    copyItem(relativePath);
  }

  for (const relativePath of dirsToCopy) {
    copyItem(relativePath);
  }

  console.log(`Web export ready in ${outDir}`);
}

main();
