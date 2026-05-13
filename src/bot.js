/**
 * @fileoverview Main bot orchestration module.
 * Integrates the WhatsApp Baileys library with Instagram extraction and sticker processing logic.
 * Manages event loops, authentication state, and message dispatching.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const fs = require("fs-extra");

const {
  AUTH_DIR,
  isSupportedLink,
  extractInstagramUrl,
  ensureTemp,
  delay,
} = require("./utils");
const { downloadInstagramImages } = require("./instagram");
const { convertToSticker } = require("./sticker");

// Orchestration Configuration
const MAX_RECONNECT_DELAY_MS = 30000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const STICKER_SEND_DELAY_MS = 800;

/**
 * Message prefixes used by the bot to identify its own responses.
 * Used to prevent infinite message loops.
 */
const BOT_RESPONSE_PREFIXES = ["⏳", "✅", "❌", "🔄", "📸"];

// Application State
let reconnectAttempts = 0;
let isProcessingActive = false;

/**
 * Normalizes and extracts text content from various Baileys message structures.
 * Handles standard conversations, extended text, ephemeral, and view-once messages.
 *
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg - The raw message object.
 * @returns {string} The extracted plain text content.
 */
function extractMessageText(msg) {
  if (!msg.message) return "";

  const content = msg.message;

  // Standard and Extended Text
  if (content.conversation) return content.conversation.trim();
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text.trim();

  // Ephemeral Wrapper
  if (content.ephemeralMessage?.message) {
    const internal = content.ephemeralMessage.message;
    if (internal.conversation) return internal.conversation.trim();
    if (internal.extendedTextMessage?.text) return internal.extendedTextMessage.text.trim();
  }

  // View-Once Wrapper
  if (content.viewOnceMessage?.message?.extendedTextMessage?.text) {
    return content.viewOnceMessage.message.extendedTextMessage.text.trim();
  }

  return "";
}

/**
 * Initializes and starts the WhatsApp bot instance.
 * Sets up authentication, event listeners for connections, and message processing.
 *
 * @returns {Promise<void>}
 */
async function startBot() {
  await ensureTemp();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version: baileysVersion } = await fetchLatestBaileysVersion();

  console.log(`Initializing WhatsApp Bot (Engine: Baileys v${baileysVersion.join(".")})`);

  const socket = makeWASocket({
    version: baileysVersion,
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" }),
    browser: ["Linux", "Chrome", "1.0.0"],
  });

  // Persist authentication credentials on update
  socket.ev.on("creds.update", saveCreds);

  // Connection Lifecycle Management
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Action Required: Scan the QR code in WhatsApp > Linked Devices.");
    }

    if (connection === "open") {
      console.log("System Status: WhatsApp connected and ready.");
      reconnectAttempts = 0;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (!isLoggedOut) {
        reconnectAttempts++;
        const backoffMs = Math.min(
          INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
          MAX_RECONNECT_DELAY_MS
        );

        console.log(`Connection lost. Retrying in ${backoffMs / 1000}s (Attempt ${reconnectAttempts})...`);
        await delay(backoffMs);
        startBot();
      } else {
        console.error("Critical: User logged out. Please delete the /auth directory and restart.");
      }
    }
  });

  // Inbound Message Handler
  socket.ev.on("messages.upsert", async ({ messages }) => {
    const rawMessage = messages[0];
    if (!rawMessage?.message || rawMessage.key.remoteJid === "status@broadcast") return;

    const messageText = extractMessageText(rawMessage);
    if (!messageText) return;

    // Filter: Ignore bot's own responses and unsupported links
    if (BOT_RESPONSE_PREFIXES.some((prefix) => messageText.startsWith(prefix))) return;
    if (!isSupportedLink(messageText)) return;

    const instagramUrl = extractInstagramUrl(messageText);
    if (!instagramUrl) return;

    const chatJid = rawMessage.key.remoteJid;
    console.log(`Processing inbound request: ${instagramUrl} from ${chatJid}`);

    if (isProcessingActive) {
      await socket.sendMessage(chatJid, {
        text: "🔄 Concurrency Limit: Another request is currently being processed. Please wait.",
      });
      return;
    }

    isProcessingActive = true;

    try {
      await socket.sendMessage(chatJid, { text: "⏳ Accessing Instagram content..." });

      const imageFilePaths = await downloadInstagramImages(instagramUrl);
      console.log(`Conversion Pipeline: Processing ${imageFilePaths.length} image(s).`);

      let successfullySentCount = 0;

      for (let i = 0; i < imageFilePaths.length; i++) {
        try {
          const stickerPath = await convertToSticker(imageFilePaths[i]);

          await socket.sendMessage(chatJid, {
            sticker: fs.readFileSync(stickerPath),
          });

          successfullySentCount++;

          // Immediate cleanup of processed assets
          await fs.remove(imageFilePaths[i]).catch(() => {});
          await fs.remove(stickerPath).catch(() => {});

          // Rate-limiting delay between stickers
          if (i < imageFilePaths.length - 1) {
            await delay(STICKER_SEND_DELAY_MS);
          }
        } catch (innerError) {
          console.error(`Pipeline failure for asset ${i + 1}: ${innerError.message}`);
        }
      }

      if (successfullySentCount > 0) {
        await socket.sendMessage(chatJid, {
          text: `✅ Delivered ${successfullySentCount} sticker${successfullySentCount > 1 ? "s" : ""}.`,
        });
      } else {
        await socket.sendMessage(chatJid, {
          text: "❌ Content Mismatch: No valid images found. The post may contain only video content.",
        });
      }
    } catch (outerError) {
      console.error(`Bot Engine Error: ${outerError.message}`);
      await socket
        .sendMessage(chatJid, { text: `❌ Processing Failed: ${outerError.message}` })
        .catch(() => {});
    } finally {
      isProcessingActive = false;
    }
  });
}

module.exports = { startBot };
