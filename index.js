/**
 * @fileoverview Application entry point for The Stickerist.
 * Responsible for initial system cleanup, process-level error handling, and bootstrapping the bot engine.
 */

const { startBot } = require("./src/bot");
const { killZombieBrowsers } = require("./src/utils");

/**
 * Global Exception Handler
 * Logs critical uncaught exceptions to prevent silent process crashes.
 */
process.on("uncaughtException", (error) => {
  console.error("Critical: Uncaught Exception detected:");
  console.error(error.message);
  console.error(error.stack);
});

/**
 * Global Rejection Handler
 * Tracks unhandled promise rejections for debugging asynchronous failures.
 */
process.on("unhandledRejection", (reason) => {
  console.error("Critical: Unhandled Promise Rejection:", reason);
});

/**
 * Bootstrap sequence:
 * 1. Terminate stale browser processes from previous sessions.
 * 2. Initialize the WhatsApp bot engine.
 */
(async function bootstrap() {
  try {
    killZombieBrowsers();
    await startBot();
  } catch (error) {
    console.error("Initialization Failed during bootstrap:", error.message);
    process.exit(1);
  }
})();
