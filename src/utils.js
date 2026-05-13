/**
 * @fileoverview Shared utility functions and configuration constants for The Stickerist.
 * Provides file system management, environment discovery, and string parsing logic.
 */

const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");

// Directory Configuration
const TEMP_DIR = path.join(__dirname, "..", "temp");
const AUTH_DIR = path.join(__dirname, "..", "auth");
const COOKIES_PATH = path.join(__dirname, "..", "cookies.txt");

// Validation Patterns
const INSTAGRAM_POST_REGEX = /https?:\/\/(www\.)?instagram\.com\/(p|share)\/[A-Za-z0-9_-]+/i;

/**
 * Common installation paths for Chromium-based browsers across different platforms.
 * Used for automated browser discovery when BROWSER_PATH is not provided.
 * @type {string[]}
 */
const BROWSER_CANDIDATES = [
  // Termux (Android)
  "/data/data/com.termux/files/usr/bin/chromium-browser",
  // Linux Standard Paths
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/microsoft-edge",
  "/usr/bin/opera",
  "/usr/bin/vivaldi-stable",
  "/usr/bin/vivaldi",
  "/usr/bin/yandex-browser-stable",
  // Snap / Flatpak (Linux)
  "/snap/bin/chromium",
  // macOS Application Paths
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Opera.app/Contents/MacOS/Opera",
  "/Applications/Opera GX.app/Contents/MacOS/Opera",
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  // Windows System Paths
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Opera\\opera.exe",
  "C:\\Program Files\\Opera GX\\opera.exe",
  "C:\\Program Files (x86)\\Opera\\opera.exe",
  "C:\\Program Files (x86)\\Opera GX\\opera.exe",
  "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe",
];

/**
 * Relative paths for per-user Windows browser installations.
 * @type {string[]}
 */
const WINDOWS_USER_CANDIDATES = [
  "Google\\Chrome\\Application\\chrome.exe",
  "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "Opera Software\\Opera Stable\\opera.exe",
  "Opera Software\\Opera GX Stable\\opera.exe",
  "Vivaldi\\Application\\vivaldi.exe",
];

/**
 * Resolves the absolute path to a Chromium-based browser executable.
 * Prioritizes the BROWSER_PATH environment variable, then probes common system locations.
 *
 * @returns {string} The absolute path to the browser executable.
 * @throws {Error} If no compatible browser is found on the system.
 */
function resolveBrowserExecutablePath() {
  const envPath = process.env.BROWSER_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    throw new Error(`Environment variable BROWSER_PATH set to "${envPath}" but file was not found.`);
  }

  // Probe standard system candidates
  for (const candidate of BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Probe Windows-specific user data directories
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    for (const relative of WINDOWS_USER_CANDIDATES) {
      const full = path.join(localAppData, relative);
      if (fs.existsSync(full)) return full;
    }
  }

  throw new Error(
    "Critical: No Chromium-based browser detected. Please install a browser or set BROWSER_PATH."
  );
}

const browserPath = resolveBrowserExecutablePath();

/**
 * Validates if a given string contains a supported Instagram post or share link.
 * @param {string} text - The message text to validate.
 * @returns {boolean} True if the link is supported.
 */
function isSupportedLink(text) {
  return INSTAGRAM_POST_REGEX.test(text);
}

/**
 * Extracts the first Instagram URL from a string.
 * @param {string} text - The source text.
 * @returns {string|null} The extracted URL or null if no match is found.
 */
function extractInstagramUrl(text) {
  const match = text.match(INSTAGRAM_POST_REGEX);
  return match ? match[0] : null;
}

/**
 * Ensures the temporary processing directory exists.
 * @returns {Promise<void>}
 */
async function ensureTemp() {
  await fs.ensureDir(TEMP_DIR);
}

/**
 * Purges all contents of the temporary processing directory.
 * @returns {Promise<void>}
 */
async function cleanTemp() {
  await fs.emptyDir(TEMP_DIR);
}

/**
 * Pauses execution for a specified duration.
 * @param {number} ms - Delay duration in milliseconds.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a cookies.txt file into Puppeteer-compatible cookie objects.
 * Expects a semicolon-separated string of name=value pairs.
 *
 * @returns {Object[]} Array of cookie objects for the instagram.com domain.
 */
function parseCookies() {
  try {
    if (!fs.existsSync(COOKIES_PATH)) return [];

    const raw = fs.readFileSync(COOKIES_PATH, "utf8").trim();
    if (!raw) return [];

    const pairs = raw.split(/;\s*/);

    return pairs
      .map((pair) => {
        const eqIndex = pair.indexOf("=");
        if (eqIndex === -1) return null;

        const name = pair.slice(0, eqIndex).trim();
        const value = pair.slice(eqIndex + 1).trim();

        if (!name) return null;

        return {
          name,
          value,
          domain: ".instagram.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "None",
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`Failed to parse ${COOKIES_PATH}:`, err.message);
    return [];
  }
}

/**
 * Terminates any active Chromium-family processes to prevent resource leakage.
 * Targets processes associated with the currently resolved browser executable.
 */
function killZombieBrowsers() {
  const executableName = path.basename(browserPath).split("-")[0].split(".")[0];
  const processTargets = new Set(["brave", "chromium", "chrome", executableName]);

  for (const processName of processTargets) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /IM "${processName}*" 2>nul`, { stdio: "ignore" });
      } else {
        execSync(`pkill -f "${processName}" 2>/dev/null || true`, { stdio: "ignore" });
      }
    } catch {
      // Intentional: Silently ignore if no matching processes are found
    }
  }
}

module.exports = {
  TEMP_DIR,
  AUTH_DIR,
  COOKIES_PATH,
  browserPath,
  isSupportedLink,
  extractInstagramUrl,
  ensureTemp,
  cleanTemp,
  delay,
  parseCookies,
  killZombieBrowsers,
};
