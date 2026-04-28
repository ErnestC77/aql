require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const sessions = {};

// =====================
// CONFIG
// =====================
const CACHE_TTL = 5 * 60 * 1000;
const sheetCache = new Map();
const commandKeywords = ["menu", "меню", "start", "старт"];

const DEFAULT_SHEET_NAME = "Sheet1";

const aircraftSheetMap = {
  "ER-BAS": "B747F",
  "ER-BYK": "B747F",
  "ER-GAG": "B777-B747PAX",
};

function getSheetNameByAircraft(a) {
  return aircraftSheetMap[a] || DEFAULT_SHEET_NAME;
}

// =====================
// HELPERS
// =====================
function isCommandKeyword(text) {
  return commandKeywords.includes(text.toLowerCase());
}

function todayDate() {
  return new Date().toLocaleDateString("ru-RU");
}

function extractIncomingText(message) {
  if (message.type === "text") return message.text.body.trim();

  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.id ||
      ""
    );
  }

  return "";
}

// =====================
// GOOGLE
// =====================
async function getSheetsClient() {
  if (!process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error("NO GOOGLE KEY");
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function saveRowsToSheet(baseData, equipmentEntries, createdBy) {
  console.log("SAVE TO SHEET:", { baseData, equipmentEntries, createdBy });

  const sheets = await getSheetsClient();
  const sheetName = getSheetNameByAircraft(baseData["Aircraft"]);

  const rows = equipmentEntries.map((item) => [
    baseData["Flight"] || "",
    baseData["Date"] || "",
    item.equipment || "",
    item.timeIn || "",
    item.timeOut || "",
    "",
    baseData["Aircraft"] || "",
    baseData["Airport"] || "",
    baseData["Engineer Name"] || "",
    "",
    "",
    createdBy,
    new Date().toISOString(),
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A:M`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

// =====================
// WHATSAPP
// =====================
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
    }
  );
}

// =====================
// WEBHOOK
// =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = extractIncomingText(message);
    if (!text) return;

    if (!sessions[from]) {
      sessions[from] = {
        mode: "menu",
        baseData: {},
        equipmentEntries: [],
      };

      await sendMessage(from, "Сессия сброшена. Напишите menu.");
      return;
    }

    const session = sessions[from];

    console.log("INCOMING:", {
      from,
      text,
      mode: session.mode,
      baseData: session.baseData,
      equipmentEntries: session.equipmentEntries,
    });

    // =====================
    // FORCE SAVE (главный фикс)
    // =====================
    if (text === "SAVE_YES") {
      if (!session.equipmentEntries.length) {
        await sendMessage(from, "Нет данных для сохранения");
        return;
      }

      try {
        await saveRowsToSheet(
          session.baseData,
          session.equipmentEntries,
          from
        );

        await sendMessage(from, "✅ Сохранено");
      } catch (e) {
        console.error("SAVE ERROR:", e);
        await sendMessage(from, "❌ Ошибка сохранения");
      }

      return;
    }

    // =====================
    // TEST COMMAND
    // =====================
    if (text === "test") {
      sessions[from] = {
        mode: "confirm",
        baseData: {
          Flight: "TVR4701",
          Date: todayDate(),
          Aircraft: "ER-BAS",
          Airport: "DWC",
          "Engineer Name": "Test",
        },
        equipmentEntries: [
          { equipment: "GPU", timeIn: "10:00", timeOut: "12:00" },
        ],
      };

      await sendMessage(from, "Данные подготовлены. Нажми SAVE");
      return;
    }

  } catch (err) {
    console.error(err);
  }
});

app.listen(3000, () => console.log("RUNNING"));