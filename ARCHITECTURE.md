# System Architecture: The Stickerist

This document outlines the high-level design, component boundaries, and data flow of The Stickerist.

## 1. System Overview

The system is a Node.js-based automation tool designed to bridge Instagram content with WhatsApp's sticker ecosystem. It operates as a reactive event loop, triggered by specific message patterns on WhatsApp.

## 2. Core Components

### 2.1 Bot Orchestrator (`src/bot.js`)
- **Boundary**: Interface between the network (WhatsApp) and internal processing logic.
- **Responsibilities**:
    - Manage Baileys socket lifecycle.
    - Route inbound messages to the extraction pipeline.
    - Manage concurrency (preventing race conditions during scraping).
    - Dispatch output (stickers) back to the user.

### 2.2 Content Extractor (`src/instagram.js`)
- **Boundary**: Headless browser automation layer.
- **Responsibilities**:
    - Browser lifecycle management (via Puppeteer-core).
    - DOM manipulation and UI interaction (carousel navigation).
    - Visual capture of assets (screenshots).
    - Robustness via retry logic and exponential backoff.

### 2.3 Asset Processor (`src/sticker.js`)
- **Boundary**: Image processing and encoding pipeline.
- **Responsibilities**:
    - Resizing and padding images to 512x512.
    - WebP encoding for WhatsApp compatibility.
    - Iterative compression to satisfy the strict 100KB file size limit.

### 2.4 Utility Layer (`src/utils.js`)
- **Boundary**: Shared cross-cutting concerns.
- **Responsibilities**:
    - Environment discovery (browser path resolution).
    - File system sanitation.
    - Persistent state parsing (cookies.txt).
    - Resource cleanup (zombie browser management).

## 3. Data Flow

1.  **Ingress**: `bot.js` receives a `messages.upsert` event.
2.  **Validation**: `utils.js` verifies if the message contains a supported Instagram URL.
3.  **Extraction**: `instagram.js` launches a headless browser, navigates to the URL, and saves raw images to `temp/`.
4.  **Transformation**: `sticker.js` reads raw images, processes them, and saves optimized `.webp` stickers to `temp/`.
5.  **Egress**: `bot.js` reads the final stickers and sends them via the Baileys socket.
6.  **Cleanup**: System purges `temp/` files after successful delivery or on failure.

## 4. Design Decisions & Trade-offs

- **Headless Browser vs. Private API**: Used a browser to avoid Instagram's aggressive API rate limiting and structural changes.
- **Iterative Compression**: Prioritizes sticker delivery over absolute image quality when nearing the 100KB limit.
- **Multi-File Auth**: Allows for persistent sessions without requiring re-pairing after process restarts.
- **Sequential Processing**: Intentionally limits concurrency to 1 to prevent resource exhaustion on low-spec hardware (e.g., Raspberry Pi, Termux).
