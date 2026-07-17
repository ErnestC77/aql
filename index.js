const express = require("express");
const { validateRequiredEnv, verifySignature } = require("./security");
const { createWebhookProcessor } = require("./webhook");
const { SESSION_TTL } = require("./core");

// env, deps are injected so this is testable without a real server, real
// WhatsApp token, or real Google Sheets credentials (see test/index.test.js).
function createApp({ env, deps, sessions = {} }) {
  const app = express();

  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.get("/health", (req, res) => {
    res.sendStatus(200);
  });

  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    res.sendStatus(403);
  });

  const processor = createWebhookProcessor({ sessions, deps });

  app.post("/webhook", async (req, res) => {
    if (env.APP_SECRET) {
      const signature = req.get("X-Hub-Signature-256");

      if (!verifySignature(env.APP_SECRET, req.rawBody, signature)) {
        res.sendStatus(403);
        return;
      }
    }

    // ACK сразу — WhatsApp повторяет доставку, если не получит быстрый 200.
    res.sendStatus(200);

    try {
      await processor.handleWebhookBody(req.body);
    } catch (err) {
      console.error("Webhook processing error:", err.response?.data || err.message || err);
    }
  });

  return { app, sessions };
}

function main() {
  require("dotenv").config();

  const missing = validateRequiredEnv(process.env);
  if (missing.length > 0) {
    console.error(`FATAL: missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  if (!process.env.APP_SECRET) {
    console.warn(
      "WARNING: APP_SECRET is not set — webhook signature verification is DISABLED. " +
        "Anyone who learns the URL can forge WhatsApp events. Set APP_SECRET (Meta App Secret) to enable verification."
    );
  }

  const { createWhatsAppClient } = require("./whatsapp");
  const { getSheetsClient, createSheetsService } = require("./sheets");

  const wa = createWhatsAppClient({
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.PHONE_NUMBER_ID,
  });

  const sheetsService = createSheetsService(getSheetsClient(), process.env.GOOGLE_SHEET_ID);

  const deps = {
    sendMessage: wa.sendMessage,
    sendButtons: wa.sendButtons,
    sendList: wa.sendList,
    saveRowsToSheet: sheetsService.saveRowsToSheet,
    getLast10Rows: sheetsService.getLast10Rows,
    updateCell: sheetsService.updateCell,
    deleteRow: sheetsService.deleteRow,
    getRow: sheetsService.getRow,
    moveRow: sheetsService.moveRow,
  };

  const sessions = {};

  setInterval(() => {
    const now = Date.now();
    for (const phone in sessions) {
      if (now - (sessions[phone].lastActive || 0) > SESSION_TTL) {
        delete sessions[phone];
      }
    }
  }, 10 * 60 * 1000);

  const { app } = createApp({ env: process.env, deps, sessions });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Bot started on port ${port}`));
}

if (require.main === module) {
  main();
}

module.exports = { createApp };
