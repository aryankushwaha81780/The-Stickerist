/**
 * @fileoverview Instagram content extraction module.
 * Orchestrates a headless browser to navigate Instagram posts and capture high-resolution
 * images from both single-image posts and multi-slide carousels.
 */

const puppeteer = require("puppeteer-core");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const { TEMP_DIR, browserPath, delay, parseCookies, cleanTemp } = require("./utils");

// Extraction Configuration
const MAX_CAROUSEL_SLIDES = 20;
const MAX_EXTRACTION_RETRIES = 2;
const NAVIGATION_TIMEOUT_MS = 60000;
const POST_LOAD_WAIT_MS = 3000;
const IMAGE_STABILIZATION_WAIT_MS = 2500;
const MIN_IMAGE_DIMENSION_PX = 500;
const MIN_RENDERED_SIZE_PX = 300;

// UI Selectors
const NEXT_BUTTON_SELECTORS = [
  'button[aria-label="Next"]',
  'button[aria-label="next"]',
  'article button svg[aria-label="Next"]',
  'div[role="button"][aria-label="Next"]',
];

const MODAL_DISMISS_SELECTORS = [
  'button:has-text("Not Now")',
  'button:has-text("Not now")',
  'button:has-text("Allow all cookies")',
  'button:has-text("Accept")',
  'button:has-text("Accept All")',
  '[aria-label="Close"]',
  '[aria-label="Dismiss"]',
];

/**
 * High-level orchestration for downloading Instagram images.
 * Implements a retry mechanism with exponential backoff.
 *
 * @param {string} url - The Instagram post URL.
 * @returns {Promise<string[]>} List of absolute paths to captured local images.
 * @throws {Error} If all extraction attempts fail.
 */
async function downloadInstagramImages(url) {
  await cleanTemp();

  let finalError = null;

  for (let attempt = 1; attempt <= MAX_EXTRACTION_RETRIES; attempt++) {
    try {
      const capturedImages = await runExtractionTask(url);
      if (capturedImages.length > 0) return capturedImages;

      throw new Error("Target reached but no images were successfully captured.");
    } catch (err) {
      finalError = err;
      console.error(`Extraction attempt ${attempt}/${MAX_EXTRACTION_RETRIES} failed: ${err.message}`);

      if (attempt < MAX_EXTRACTION_RETRIES) {
        const backoffMs = attempt * 3000;
        await delay(backoffMs);
        await cleanTemp();
      }
    }
  }

  throw new Error(`Failed to extract images after ${MAX_EXTRACTION_RETRIES} attempts. Reason: ${finalError.message}`);
}

/**
 * Manages the lifecycle of the browser and page for a single extraction task.
 *
 * @param {string} url - The target Instagram URL.
 * @returns {Promise<string[]>}
 */
async function runExtractionTask(url) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "puppeteer-ig-"));

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: browserPath,
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
      ],
    });

    const page = await browser.newPage();
    await setupBrowserPage(page);

    console.log(`Navigating to: ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    // Wait for the main post content to manifest
    await page
      .waitForSelector('[role="main"] img[crossorigin="anonymous"]', { timeout: 15000 })
      .catch(() => console.warn("Primary image selector timed out. Attempting fallback capture."));

    await dismissBlockingModals(page);
    await delay(POST_LOAD_WAIT_MS);

    return await captureAllPostImages(page);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.remove(userDataDir).catch(() => {});
  }
}

/**
 * Configures viewport and identity for the browser page.
 * @param {import('puppeteer-core').Page} page
 */
async function setupBrowserPage(page) {
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  );

  const cookies = parseCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
    console.log(`Injected ${cookies.length} session cookies for Instagram authentication.`);
  }
}

/**
 * Attempts to clear intrusive modals (login prompts, cookie consent) that block interaction.
 * @param {import('puppeteer-core').Page} page
 */
async function dismissBlockingModals(page) {
  for (const selector of MODAL_DISMISS_SELECTORS) {
    try {
      if (selector.includes(":has-text(")) {
        const targetText = selector.match(/:has-text\("(.+?)"\)/)?.[1];
        if (targetText) {
          const [button] = await page.$x(
            `//button[contains(text(), '${targetText}')] | //div[@role='button'][contains(text(), '${targetText}')]`
          );
          if (button) {
            await button.click();
            await delay(500);
          }
        }
      } else {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          await delay(500);
        }
      }
    } catch {
      // Intentional: Selector not present or interaction failed
    }
  }

  try {
    await page.keyboard.press("Escape");
  } catch {}
}

/**
 * Iterates through carousel slides (if present) and captures high-res images.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string[]>}
 */
async function captureAllPostImages(page) {
  const imagePaths = [];
  const processedSources = new Set();
  let slideCounter = 0;

  const initialImage = await resolveMainPostImage(page);
  if (initialImage) {
    const src = await initialImage.evaluate((el) => el.src);
    const path = await saveImageScreenshot(page, initialImage, slideCounter);
    if (path) {
      imagePaths.push(path);
      processedSources.add(src);
      slideCounter++;
    }
  }

  while (slideCounter < MAX_CAROUSEL_SLIDES) {
    const hasNext = await isNextButtonVisible(page);
    if (!hasNext) break;

    const clickSuccess = await performNextClick(page);
    if (!clickSuccess) break;

    const nextImage = await pollForNewImage(page, processedSources);
    if (nextImage) {
      const src = await nextImage.evaluate((el) => el.src);
      const path = await saveImageScreenshot(page, nextImage, slideCounter);
      if (path) {
        imagePaths.push(path);
        processedSources.add(src);
      }
    }

    slideCounter++;
  }

  console.log(`Extraction complete: ${imagePaths.length} images captured.`);
  return imagePaths;
}

/**
 * Polls the DOM until an image with an unseen source attribute appears.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {Set<string>} processedSources
 * @param {number} timeoutMs
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
async function pollForNewImage(page, processedSources, timeoutMs = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const candidates = await page.$$("img[crossorigin='anonymous']");

    for (const img of candidates) {
      try {
        const metadata = await img.evaluate((el) => ({
          src: el.src || "",
          naturalWidth: el.naturalWidth,
          naturalHeight: el.naturalHeight,
        }));

        if (isIgnorableResource(metadata.src)) continue;
        if (metadata.naturalWidth < MIN_IMAGE_DIMENSION_PX || metadata.naturalHeight < MIN_IMAGE_DIMENSION_PX) continue;
        if (processedSources.has(metadata.src)) continue;

        const boundingBox = await img.boundingBox();
        if (!boundingBox || boundingBox.width < MIN_RENDERED_SIZE_PX || boundingBox.height < MIN_RENDERED_SIZE_PX) continue;

        return img;
      } catch {
        continue;
      }
    }

    await delay(300);
  }

  return null;
}

/**
 * Resolves the primary image element of the post based on dimensions and properties.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
async function resolveMainPostImage(page) {
  const candidates = await page.$$("img[crossorigin='anonymous']");

  let bestCandidate = null;
  let maxArea = 0;

  for (const img of candidates) {
    try {
      const metadata = await img.evaluate((el) => ({
        src: el.src || "",
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
      }));

      if (isIgnorableResource(metadata.src)) continue;
      if (metadata.naturalWidth < MIN_IMAGE_DIMENSION_PX || metadata.naturalHeight < MIN_IMAGE_DIMENSION_PX) continue;

      const box = await img.boundingBox();
      if (!box || box.width < MIN_RENDERED_SIZE_PX || box.height < MIN_RENDERED_SIZE_PX) continue;

      const area = box.width * box.height;
      if (area > maxArea) {
        maxArea = area;
        bestCandidate = img;
      }
    } catch {
      continue;
    }
  }

  return bestCandidate;
}

/**
 * Filters out thumbnails, profile pictures, and static assets.
 * @param {string} src
 * @returns {boolean}
 */
function isIgnorableResource(src) {
  if (!src) return true;
  const lowerSrc = src.toLowerCase();
  const blacklistedKeywords = ["s150x150", "s100x100", "s44x44", "s64x64", "profile", "emoji", "/s/", "static.cdninstagram"];

  return (
    blacklistedKeywords.some((keyword) => lowerSrc.includes(keyword)) ||
    lowerSrc.startsWith("data:") ||
    !lowerSrc.startsWith("http")
  );
}

/**
 * Captures a screenshot of a specific image element.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').ElementHandle} imageHandle
 * @param {number} index - Slide index for naming.
 * @returns {Promise<string|null>} Path to the saved screenshot or null if failed.
 */
async function saveImageScreenshot(page, imageHandle, index) {
  try {
    await imageHandle.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
    await delay(IMAGE_STABILIZATION_WAIT_MS);

    const imagePath = path.join(TEMP_DIR, `capture_${index}_${Date.now()}.png`);
    await imageHandle.screenshot({ path: imagePath });

    const stats = await fs.stat(imagePath);
    if (stats.size < 1024) {
      await fs.remove(imagePath).catch(() => {});
      return null;
    }

    return imagePath;
  } catch (err) {
    console.warn(`Screenshot generation failed for slide ${index}: ${err.message}`);
    return null;
  }
}

/**
 * Checks if the 'Next' button for carousel navigation is present and clickable.
 * @param {import('puppeteer-core').Page} page
 */
async function isNextButtonVisible(page) {
  for (const selector of NEXT_BUTTON_SELECTORS) {
    try {
      const element = await page.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box && box.width > 0 && box.height > 0) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Orchestrates the click interaction on the carousel 'Next' button.
 * Uses both mouse simulation and DOM dispatch as a fallback.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>} True if the click was successful.
 */
async function performNextClick(page) {
  for (const selector of NEXT_BUTTON_SELECTORS) {
    try {
      const element = await page.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return true;
        }
      }
    } catch {
      continue;
    }
  }

  // Fallback: Dispatch DOM click
  return await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Next"]') || document.querySelector('button[aria-label="next"]');
    if (button) {
      button.click();
      return true;
    }
    return false;
  }).catch(() => false);
}

module.exports = { downloadInstagramImages };
