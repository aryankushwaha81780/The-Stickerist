/**
 * @fileoverview Image processing module for converting standard images to WhatsApp-compatible stickers.
 * Utilizes the Sharp library for high-performance image manipulation and WebP encoding.
 */

const sharp = require("sharp");
const fs = require("fs-extra");
const path = require("path");
const { TEMP_DIR } = require("./utils");

// Sharp configuration for constrained environments (e.g., low-memory servers)
sharp.cache(false);
sharp.concurrency(1);

/** @constant {number} The required dimensions for WhatsApp stickers in pixels. */
const STICKER_DIMENSION_PX = 512;

/** @constant {number} The maximum allowed file size for a WhatsApp sticker in bytes (100KB). */
const MAX_STICKER_FILE_SIZE_BYTES = 100 * 1024;

/** @constant {number} The lower bound for WebP quality during iterative compression. */
const MINIMUM_COMPRESSION_QUALITY = 30;

/** @constant {number} The initial WebP quality setting. */
const INITIAL_COMPRESSION_QUALITY = 82;

/** @constant {number} The step value to reduce quality by in each compression iteration. */
const QUALITY_REDUCTION_STEP = 10;

/**
 * Converts a source image into a WhatsApp-compatible .webp sticker.
 * Performs iterative quality reduction to satisfy the 100KB file size constraint.
 *
 * @param {string} inputPath - Absolute path to the source image file.
 * @returns {Promise<string>} Absolute path to the generated .webp sticker file.
 * @throws {Error} If the input file is missing, empty, or processing fails.
 */
async function convertToSticker(inputPath) {
  const fileStats = await fs.stat(inputPath).catch(() => null);
  if (!fileStats || fileStats.size === 0) {
    throw new Error(`Invalid input: File at ${inputPath} is missing or empty.`);
  }

  const fileExtension = path.extname(inputPath);
  const baseFileName = path.basename(inputPath, fileExtension);
  const outputPath = path.join(TEMP_DIR, `${baseFileName}_sticker.webp`);

  let currentQuality = INITIAL_COMPRESSION_QUALITY;

  /**
   * Internal helper to perform a single resize and encode operation.
   * @param {number} quality - The WebP quality level (1-100).
   */
  const processImage = async (quality) => {
    await sharp(inputPath)
      .resize(STICKER_DIMENSION_PX, STICKER_DIMENSION_PX, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality })
      .toFile(outputPath);
  };

  // Initial processing attempt
  await processImage(currentQuality);
  let outputStats = await fs.stat(outputPath);

  // Iteratively reduce quality if the file size exceeds WhatsApp's limit
  while (
    outputStats.size > MAX_STICKER_FILE_SIZE_BYTES &&
    currentQuality > MINIMUM_COMPRESSION_QUALITY
  ) {
    currentQuality -= QUALITY_REDUCTION_STEP;
    await processImage(currentQuality);
    outputStats = await fs.stat(outputPath);
  }

  if (outputStats.size > MAX_STICKER_FILE_SIZE_BYTES) {
    console.warn(
      `Warning: Sticker ${baseFileName} (${Math.round(
        outputStats.size / 1024
      )}KB) exceeds the 100KB limit at minimum quality (${currentQuality}).`
    );
  }

  return outputPath;
}

module.exports = { convertToSticker };
