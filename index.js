require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const sessions = {};
const SESSION_TTL = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const now = Date.now();
  for (const phone in sessions) {
    if (now - (sessions[phone].lastActive || 0) > SESSION_TTL) {
      delete sessions[phone];
    }
  }
}, 10 * 60 * 1000);

// =====================
// Cache & Constants
// =====================
const CACHE_TTL = 5 * 60 * 1000;
const sheetCache = new Map();
const commandKeywords = ["menu", "меню", "start", "старт", "помощь", "help"];

// =====================
// Google Sheet tabs
// =====================
const aircraftSheetMap = {
  "ER-BAS": "B747F",
  "ER-BYK": "B747F",
  "ER-GAG": "B777-B747PAX",
  "ER-JAN": "B777-B747PAX",
  "ER-HAJ": "B777-B747PAX",
  "ER-BOY": "B777-B747PAX",
  "ER-BOS": "B777-B747PAX",
  "ER-UFC": "B733F",
  "ER-BCT": "B733F",
  "P4-AQQ": "B733F",
};

const DEFAULT_SHEET_NAME = "Sheet1";
const ALL_SHEET_NAMES = [...new Set(Object.values(aircraftSheetMap))];

function getSheetNameByAircraft(aircraft) {
  return aircraftSheetMap[aircraft] || DEFAULT_SHEET_NAME;
}

// =====================
// Lists (Pre-mapped)
// =====================
const aircraftList = [
  "ER-BAS", "ER-BYK", "ER-GAG", "ER-JAN", "ER-HAJ",
  "ER-BOY", "ER-BOS", "ER-UFC", "ER-BCT", "P4-AQQ"
];

const airportList = ["DWC", "HKG", "SHJ", "AUH", "FJR", "SYD", "JED", "MED", "KGF"];

const equipmentList = [
  "PAXSTEP", "GPU", "SCISSORLIFT", "NITROGEN", "JACK", "DOLLY"
];

const flightList = [
  "TVR4701", "TVR4702", "TVR4703", "TVR4704",
  "TVR4707", "TVR4716", "TVR4717", "Maintenance"
];

const editableFields = [
  { key: "Flight", label: "Номер рейса", col: 1 },
  { key: "Date", label: "Дата", col: 2 },
  { key: "Equipment / Company", label: "Оборудование", col: 3 },
  { key: "Time in", label: "Время начала", col: 4 },
  { key: "Time out", label: "Время окончания", col: 5 },
  { key: "Aircraft", label: "Самолёт", col: 7 },
  { key: "Airport", label: "Аэропорт", col: 8 },
  { key: "Engineer Name", label: "Инженер", col: 9 },
];

// =====================
// Helpers
// =====================
function short(text, max = 24) {
  if (!text) return "";
  return text.length > max ? text.substring(0, max - 3) + "..." : text;
}

function todayDate() {
  return new Date().toLocaleDateString("ru-RU");
}

function isCommandKeyword(text) {
  return !!text && commandKeywords.includes(text.toLowerCase());
}

function calculateUsage(timeIn, timeOut) {
  if (!timeIn || !timeOut) return "";

  const [h1, m1] = timeIn.split(":").map(Number);
  const [h2, m2] = timeOut.split(":").map(Number);

  if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return "";

  let start = h1 * 60 + m1;
  let end = h2 * 60 + m2;

  if (end < start) end += 24 * 60;

  const diff = end - start;
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;

  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function isValidTime(t) {
  if (!t) return false;
  return /^\d{1,2}:\d{2}$/.test(t.trim());
}

function parseDateTime(dateText, timeText) {
  if (!dateText || !timeText) return null;

  const [day, month, year] = dateText.split(".").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);

  if (!day || !month || !year || isNaN(hour) || isNaN(minute)) return null;

  return new Date(year, month - 1, day, hour, minute);
}

function extractIncomingText(message) {
  if (message.type === "text") return message.text.body.trim();

  if (message.type === "interactive") {
    if (message.interactive.type === "button_reply") {
      return message.interactive.button_reply.id;
    }

    if (message.interactive.type === "list_reply") {
      return message.interactive.list_reply.id;
    }
  }

  return "";
}

// =====================
// Google Sheets
// =====================
async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function getSheetIdByName(sheetName) {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
    });
    const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
    return sheet?.properties.sheetId || 0;
  } catch (error) {
    console.error("Error getting sheet ID:", error);
    return 0;
  }
}

async function saveRowsToSheet(baseData, equipmentEntries, createdBy) {
  try {
    const sheets = await getSheetsClient();
    const sheetName = getSheetNameByAircraft(baseData["Aircraft"]);
    const createdAt = new Date().toISOString();

    const rows = equipmentEntries.map((item) => [
      baseData["Flight"] || "",
      baseData["Date"] || "",
      item.equipment || "",
      item.timeIn || "",
      item.timeOut || "",
      calculateUsage(item.timeIn, item.timeOut),
      baseData["Aircraft"] || "",
      baseData["Airport"] || "",
      baseData["Engineer Name"] || "",
      "",
      "",
      createdBy || "",
      createdAt,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!A:M`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });

    sheetCache.delete(sheetName);
  } catch (error) {
    console.error("Error saving rows to sheet:", error);
    throw error;
  }
}

async function getAllRowsFromSheet(sheetName) {
  try {
    const cached = sheetCache.get(sheetName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!A:M`,
    });

    const data = res.data.values || [];
    
    sheetCache.set(sheetName, {
      data,
      timestamp: Date.now(),
    });

    return data;
  } catch (error) {
    console.error("Error getting rows from sheet:", error);
    throw error;
  }
}

async function getLast10Rows(createdBy) {
  try {
    const results = await Promise.all(
      ALL_SHEET_NAMES.map(async (sheetName) => {
        const rows = await getAllRowsFromSheet(sheetName);
        return { sheetName, rows };
      })
    );

    const found = [];

    for (const item of results) {
      for (let i = 1; i < item.rows.length; i++) {
        const row = item.rows[i];

        if (row[11] !== createdBy) continue;
        
        const parsedDate = row[12] ? new Date(row[12]) : null;
        const createdAt = (parsedDate && !isNaN(parsedDate))
          ? parsedDate
          : parseDateTime(row[1], row[3]);

        found.push({
          sheetName: item.sheetName,
          rowNumber: i + 1,
          row,
          createdAt: createdAt || new Date(0),
        });
      }
    }

    return found
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);
  } catch (error) {
    console.error("Error getting last 10 rows:", error);
    throw error;
  }
}

async function updateCell(sheetName, rowNumber, columnNumber, value) {
  try {
    const sheets = await getSheetsClient();
    const columnLetter = String.fromCharCode(64 + columnNumber);

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `'${sheetName}'!${columnLetter}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] },
    });

    sheetCache.delete(sheetName);
  } catch (error) {
    console.error("Error updating cell:", error);
    throw error;
  }
}

async function deleteRow(sheetName, rowNumber) {
  try {
    const sheets = await getSheetsClient();
    const sheetId = await getSheetIdByName(sheetName);
    
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: "ROWS",
                startIndex: rowNumber - 1,
                endIndex: rowNumber,
              },
            },
          },
        ],
      },
    });

    sheetCache.delete(sheetName);
  } catch (error) {
    console.error("Error deleting row:", error);
    throw error;
  }
}

async function recalculateTotalUsage(sheetName, rowNumber, timeIn, timeOut) {
  try {
    let resolvedTimeIn = timeIn;
    let resolvedTimeOut = timeOut;

    if (resolvedTimeIn === undefined || resolvedTimeOut === undefined) {
      const rows = await getAllRowsFromSheet(sheetName);
      const row = rows[rowNumber - 1];
      if (!row || row.length < 5) return;
      resolvedTimeIn = resolvedTimeIn ?? row[3];
      resolvedTimeOut = resolvedTimeOut ?? row[4];
    }

    const totalUsage = calculateUsage(resolvedTimeIn, resolvedTimeOut);
    await updateCell(sheetName, rowNumber, 6, totalUsage);
  } catch (error) {
    console.error("Error recalculating usage:", error);
    throw error;
  }
}

// =====================
// WhatsApp sending
// =====================
async function sendMessage(to, text) {
  try {
    const token = process.env.WHATSAPP_TOKEN.trim();
    const phoneNumberId = process.env.PHONE_NUMBER_ID.trim();

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
  } catch (error) {
    console.error("Error sending message:", error.response?.data || error.message);
    throw error;
  }
}

async function sendButtons(to, body, buttons) {
  try {
    const token = process.env.WHATSAPP_TOKEN.trim();
    const phoneNumberId = process.env.PHONE_NUMBER_ID.trim();

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            buttons: buttons.slice(0, 3).map((btn) => ({
              type: "reply",
              reply: {
                id: btn.id,
                title: short(btn.title, 20),
              },
            })),
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
  } catch (error) {
    console.error("Error sending buttons:", error.response?.data || error.message);
    throw error;
  }
}

async function sendList(to, body, buttonText, rows) {
  try {
    const token = process.env.WHATSAPP_TOKEN.trim();
    const phoneNumberId = process.env.PHONE_NUMBER_ID.trim();

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: {
            button: short(buttonText, 20),
            sections: [
              {
                title: "Выбор",
                rows: rows.slice(0, 10).map((row) => ({
                  id: row.id,
                  title: short(row.title, 24),
                  description: short(row.description || "", 72),
                })),
              },
            ],
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
  } catch (error) {
    console.error("Error sending list:", error.response?.data || error.message);
    throw error;
  }
}

// =====================
// Menu functions
// =====================
async function showMainMenu(to) {
  await sendButtons(to, "🏠 Главное меню:", [
    { id: "BTN_ADD", title: "➕ Добавить запись" },
    { id: "BTN_LIST", title: "📋 Мои записи" },
    { id: "BTN_EDIT", title: "✏️ Редактировать" },
    { id: "BTN_DELETE", title: "🗑️ Удалить" },
    { id: "BTN_HELP", title: "❓ Справка" },
  ]);
}

async function goToMainMenu(from, session) {
  session.mode = "menu";
  session.records = null;
  session.editRecord = null;
  session.deleteRecord = null;
  await showMainMenu(from);
}

// =====================
// Parse single-line input
// =====================
function parseInputLine(text) {
  // Формат: РЕЙС, ДАТА, САМОЛЕТ, АЭРОПОРТ, ИНЖЕНЕР; ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА, ВРЕМЯ_КОНЦА; ОБОРУДОВАНИЕ2, ВРЕМЯ_НАЧАЛА2, ВРЕМЯ_КОНЦА2; ...
  // Пример: TVR4701, 30.04.2026, ER-BAS, DWC, Ernest; PAXSTEP, 10:00, 12:30; GPU, 12:45, 15:20
  
  const parts = text.split(";").map(p => p.trim());
  
  if (parts.length < 1) {
    return null;
  }

  // Parse base data from first part
  const baseParts = parts[0].split(",").map(p => p.trim());
  
  if (baseParts.length < 5) {
    return null; // Need at least: flight, date, aircraft, airport, engineer
  }

  const baseData = {
    "Flight": baseParts[0].toUpperCase(),
    "Date": baseParts[1],
    "Aircraft": baseParts[2].toUpperCase(),
    "Airport": baseParts[3].toUpperCase(),
    "Engineer Name": baseParts[4],
  };

  // Validate base data
  if (!aircraftList.includes(baseData["Aircraft"])) {
    return null;
  }
  if (!airportList.includes(baseData["Airport"])) {
    return null;
  }

  // Parse equipment entries (starting from part 1)
  const equipmentEntries = [];
  for (let i = 1; i < parts.length; i++) {
    const equipParts = parts[i].split(",").map(p => p.trim());
    
    if (equipParts.length < 3) continue; // Need: equipment, timeIn, timeOut
    
    const equipment = equipParts[0].toUpperCase();
    const timeIn = equipParts[1];
    const timeOut = equipParts[2];

    if (!equipment || !isValidTime(timeIn) || !isValidTime(timeOut)) {
      return null;
    }

    equipmentEntries.push({ equipment, timeIn, timeOut });
  }

  if (equipmentEntries.length === 0) {
    return null;
  }

  return { baseData, equipmentEntries };
}

function getColumnByField(fieldKey) {
  const item = editableFields.find((f) => f.key === fieldKey);
  return item?.col;
}

// =====================
// Webhook verify
// =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// =====================
// Main webhook
// =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = extractIncomingText(message);
    if (!text) return;

    // Initialize session if needed
    if (!sessions[from]) {
      sessions[from] = {
        mode: "menu",
        lastActive: Date.now(),
      };
      await showMainMenu(from);
      return;
    }

    const session = sessions[from];
    session.lastActive = Date.now();

    // =====================
    // Button handlers
    // =====================
    
    // Main menu buttons
    if (text === "BTN_ADD") {
      await sendMessage(from, `Введите данные в одну строку в формате:
РЕЙС, ДАТА, САМОЛЕТ, АЭРОПОРТ, ИНЖЕНЕР; ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА, ВРЕМЯ_КОНЦА; ОБОРУДОВАНИЕ2, ВРЕМЯ_НАЧАЛА2, ВРЕМЯ_КОНЦА2; ...

Пример:
TVR4701, 30.04.2026, ER-BAS, DWC, Ernest; PAXSTEP, 10:00, 12:30; GPU, 12:45, 15:20`);
      session.mode = "menu";
      return;
    }

    if (text === "BTN_LIST") {
      try {
        const found = await getLast10Rows(from);

        if (found.length === 0) {
          await sendMessage(from, "У вас нет записей.");
          await goToMainMenu(from, session);
          return;
        }

        const listRows = found.map((item, index) => ({
          id: `VIEW_RECORD_${index}`,
          title: short(`${item.row[0]} ${item.row[1]}`, 24),
          description: short(`Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || "не окончено"}`, 72),
        }));

        session.mode = "view_records";
        session.records = found;

        await sendList(from, "Ваши последние 10 записей:", "Выбрать", listRows);
      } catch (error) {
        console.error("Error listing records:", error);
        await sendMessage(from, "Ошибка при загрузке записей.");
        await goToMainMenu(from, session);
      }
      return;
    }

    if (text === "BTN_EDIT") {
      try {
        const found = await getLast10Rows(from);

        if (found.length === 0) {
          await sendMessage(from, "У вас нет записей для редактирования.");
          await goToMainMenu(from, session);
          return;
        }

        session.mode = "edit_choose_record";
        session.records = found;

        const listRows = found.map((item, index) => ({
          id: `EDIT_RECORD_${index}`,
          title: short(`${item.row[0]} ${item.row[1]}`, 24),
          description: short(`Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || ""}`, 72),
        }));

        await sendList(from, "Выберите запись для редактирования:", "Выбрать", listRows);
      } catch (error) {
        console.error("Error in EDIT mode:", error);
        await sendMessage(from, "Ошибка при загрузке записей.");
        await goToMainMenu(from, session);
      }
      return;
    }

    if (text === "BTN_DELETE") {
      try {
        const found = await getLast10Rows(from);

        if (found.length === 0) {
          await sendMessage(from, "У вас нет записей для удаления.");
          await goToMainMenu(from, session);
          return;
        }

        session.mode = "delete_choose_record";
        session.records = found;

        const listRows = found.map((item, index) => ({
          id: `DELETE_RECORD_${index}`,
          title: short(`${item.row[0]} ${item.row[1]}`, 24),
          description: short(`Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || ""}`, 72),
        }));

        await sendList(from, "Выберите запись для удаления:", "Выбрать", listRows);
      } catch (error) {
        console.error("Error in DELETE mode:", error);
        await sendMessage(from, "Ошибка при загрузке записей.");
        await goToMainMenu(from, session);
      }
      return;
    }

    if (text === "BTN_HELP") {
      await sendMessage(from, `📖 СПРАВКА ПО ИСПОЛЬЗОВАНИЮ

Формат ввода данных:
РЕЙС, ДАТА, САМОЛЕТ, АЭРОПОРТ, ИНЖЕНЕР; ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА, ВРЕМЯ_КОНЦА; ОБОРУДОВАНИЕ2, ВРЕМЯ_НАЧАЛА2, ВРЕМЯ_КОНЦА2; ...

Пример:
TVR4701, 30.04.2026, ER-BAS, DWC, Ernest; PAXSTEP, 10:00, 12:30; GPU, 12:45, 15:20

Допустимые самолеты:
${aircraftList.join(", ")}

Допустимые аэропорты:
${airportList.join(", ")}

Допустимое оборудование:
${equipmentList.join(", ")}`);
      await goToMainMenu(from, session);
      return;
    }

    // =====================
    // Command handlers (text)
    // =====================

    // Help command
    if (text.toLowerCase() === "помощь" || text.toLowerCase() === "help") {
      await sendMessage(from, `📖 СПРАВКА ПО ИСПОЛЬЗОВАНИЮ

Формат ввода данных:
РЕЙС, ДАТА, САМОЛЕТ, АЭРОПОРТ, ИНЖЕНЕР; ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА, ВРЕМЯ_КОНЦА; ОБОРУДОВАНИЕ2, ВРЕМЯ_НАЧАЛА2, ВРЕМЯ_КОНЦА2; ...

Пример:
TVR4701, 30.04.2026, ER-BAS, DWC, Ernest; PAXSTEP, 10:00, 12:30; GPU, 12:45, 15:20

Допустимые самолеты:
${aircraftList.join(", ")}

Допустимые аэропорты:
${airportList.join(", ")}

Допустимое оборудование:
${equipmentList.join(", ")}

Команды:
меню - главное меню
список - показать последние 10 записей
редакт - редактирование записи
удалить - удаление записи
помощь - эта справка`);
      await goToMainMenu(from, session);
      return;
    }

    // List records command
    if (text.toLowerCase() === "список") {
      try {
        const found = await getLast10Rows(from);

        if (found.length === 0) {
          await sendMessage(from, "У вас нет записей.");
          await goToMainMenu(from, session);
          return;
        }

        const listRows = found.map((item, index) => ({
          id: `VIEW_RECORD_${index}`,
          title: short(`${item.row[0]} ${item.row[1]}`, 24),
          description: short(`Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || "не окончено"}`, 72),
        }));

        session.mode = "view_records";
        session.records = found;

        await sendList(from, "Ваши последние 10 записей:", "Выбрать", listRows);
      } catch (error) {
        console.error("Error listing records:", error);
        await sendMessage(from, "Ошибка при загрузке записей.");
        await goToMainMenu(from, session);
      }
      return;
    }

    // View record details
    if (session.mode === "view_records" && text.startsWith("VIEW_RECORD_")) {
      const index = Number(text.replace("VIEW_RECORD_", ""));

      if (isNaN(index) || !session.records || !session.records[index]) {
        await sendMessage(from, "Запись не найдена.");
        await goToMainMenu(from, session);
        return;
      }

      const record = session.records[index];
      const row = record.row;

      const details = `📋 Детали записи:

Рейс: ${row[0] || ""}
Дата: ${row[1] || ""}
Оборудование: ${row[2] || ""}
Начало: ${row[3] || ""}
Окончание: ${row[4] || ""}
Время: ${row[5] || ""}
Борт: ${row[6] || ""}
Аэропорт: ${row[7] || ""}
Инженер: ${row[8] || ""}
Вкладка: ${record.sheetName}`;

      await sendMessage(from, details);
      await goToMainMenu(from, session);
      return;
    }

    // Edit command
    if (text.toLowerCase() === "редакт" || text.toLowerCase() === "edit") {
      try {
        const found = await getLast10Rows(from);

        if (found.length === 0) {
          await sendMessage(from, "У вас нет записей для редактирования.");
          await goToMainMenu(from, session);
          return;
        }

        session.mode = "edit_choose_record";
        session.records = found;

        const listRows = found.map((item, index) => ({
          id: `EDIT_RECORD_${index}`,
          title: short(`${item.row[0]} ${item.row[1]}`, 24),
          description: short(`Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || ""}`, 72),
        }));

        await sendList(from, "Выберите запись для редактирования:", "Выбрать", listRows);
      } catch (error) {
        console.error("Error in EDIT mode:", error);
        await sendMessage(from, "Ошибка при загрузке записей.");
        await goToMainMenu(from, session);
      }
      return;
    }

    if (session.mode === "edit_choose_record" && text.startsWith("EDIT_RECORD_")) {
      const index = Number(text.replace("EDIT_RECORD_", ""));

      if (isNaN(index) || !session.records || !session.records[index]) {
        await sendMessage(from, "Запись не найдена.");
        await goToMainMenu(from, session);
        return;
      }

      session.editRecord = session.records[index];
      session.mode = "edit_choose_field";

      await sendList(
        from,
        `Что изменить? (Борт: ${session.editRecord.row[6] || ""})`,
        "Выбрать поле",
        editableFields.map((f, i) => ({
          id: `EDIT_FIELD_${i}`,
          title: f.label,
        }))
      );
      return;
    }

    if (session.mode === "edit_choose_field" && text.startsWith("EDIT_FIELD_")) {
      const fieldIndex = Number(text.replace("EDIT_FIELD_", ""));

      if (isNaN(fieldIndex) || !editableFields[fieldIndex]) {
        await sendMessage(from, "Поле не найдено.");
        await goToMainMenu(from, session);
        return;
      }

      session.editField = editableFields[fieldIndex];
      const currentValue = session.editRecord.row?.[session.editField.col - 1] || "не найдено";

      await sendMessage(from, `Текущее значение: ${currentValue}\n\nВведите новое значение для: ${session.editField.label}`);
      session.mode = "edit_enter_value";
      return;
    }

    if (session.mode === "edit_enter_value") {
      try {
        const sheetName = session.editRecord.sheetName;
        const rowNumber = session.editRecord.rowNumber;
        const columnNumber = getColumnByField(session.editField.key);

        if (!columnNumber) {
          await sendMessage(from, "Ошибка выбора колонки.");
          await goToMainMenu(from, session);
          return;
        }

        // Validate time if needed
        if (session.editField.key === "Time in" || session.editField.key === "Time out") {
          if (!isValidTime(text)) {
            await sendMessage(from, "Неверный формат времени. Введите ЧЧ:ММ");
            return;
          }
        }

        await updateCell(sheetName, rowNumber, columnNumber, text);

        // Recalculate if time was changed
        if (session.editField.key === "Time in" || session.editField.key === "Time out") {
          const row = session.editRecord.row;
          const newTimeIn = session.editField.key === "Time in" ? text : row[3];
          const newTimeOut = session.editField.key === "Time out" ? text : row[4];
          await recalculateTotalUsage(sheetName, rowNumber, newTimeIn, newTimeOut);
        }

        await sendMessage(from, "✅ Запись обновлена.");
        await goToMainMenu(from, session);
      } catch (error) {
        console.error("Error updating record:", error);
        await sendMessage(from, "Ошибка при обновлении.");
        await goToMainMenu(from, session);
      }
      return;
    }

    // Delete command
    if (text.toLowerCase() === "удалить" || text.toLowerCase() === "delete") {
      try {
        const found = await getLast10Rows(from);

        if (found.length === 0) {
          await sendMessage(from, "У вас нет записей для удаления.");
          await goToMainMenu(from, session);
          return;
        }

        session.mode = "delete_choose_record";
        session.records = found;

        const listRows = found.map((item, index) => ({
          id: `DELETE_RECORD_${index}`,
          title: short(`${item.row[0]} ${item.row[1]}`, 24),
          description: short(`Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || ""}`, 72),
        }));

        await sendList(from, "Выберите запись для удаления:", "Выбрать", listRows);
      } catch (error) {
        console.error("Error in DELETE mode:", error);
        await sendMessage(from, "Ошибка при загрузке записей.");
        await goToMainMenu(from, session);
      }
      return;
    }

    if (session.mode === "delete_choose_record" && text.startsWith("DELETE_RECORD_")) {
      const index = Number(text.replace("DELETE_RECORD_", ""));

      if (isNaN(index) || !session.records || !session.records[index]) {
        await sendMessage(from, "Запись не найдена.");
        await goToMainMenu(from, session);
        return;
      }

      session.deleteRecord = session.records[index];
      session.mode = "delete_confirm";

      const row = session.deleteRecord.row;
      await sendButtons(from, `Удалить эту запись?
Рейс: ${row[0]}
Дата: ${row[1]}
Оборудование: ${row[2]}
Время: ${row[3]}-${row[4]}`, [
        { id: "DELETE_YES", title: "Да, удалить" },
        { id: "DELETE_NO", title: "Отмена" },
      ]);
      return;
    }

    if (session.mode === "delete_confirm") {
      if (text === "DELETE_YES") {
        try {
          const sheetName = session.deleteRecord.sheetName;
          const rowNumber = session.deleteRecord.rowNumber;

          await deleteRow(sheetName, rowNumber);
          await sendMessage(from, "✅ Запись удалена.");
        } catch (error) {
          console.error("Error deleting record:", error);
          await sendMessage(from, "Ошибка при удалении записи.");
        }
        await goToMainMenu(from, session);
        return;
      }

      if (text === "DELETE_NO") {
        await sendMessage(from, "Удаление отменено.");
        await goToMainMenu(from, session);
        return;
      }
    }

    // Menu or help
    if (isCommandKeyword(text)) {
      await showMainMenu(from);
      session.mode = "menu";
      return;
    }

    // Try to parse as single-line input
    const parsed = parseInputLine(text);

    if (!parsed) {
      await sendMessage(from, "❌ Ошибка в формате ввода.\n\nПримечание: Рейс, дата, самолет, аэропорт, инженер - обязательны.\nДля каждого оборудования нужны время начала и окончания (формат ЧЧ:ММ).\n\nПримечание: Разделяйте группы оборудования точкой с запятой (;)\n\nПример:\nTVR4701, 30.04.2026, ER-BAS, DWC, Ernest; PAXSTEP, 10:00, 12:30; GPU, 12:45, 15:20\n\nНапишите 'помощь' для справки.");
      return;
    }

    try {
      await saveRowsToSheet(parsed.baseData, parsed.equipmentEntries, from);
      
      const preview = `✅ Данные успешно сохранены!

📋 Итоги:
Рейс: ${parsed.baseData["Flight"]}
Дата: ${parsed.baseData["Date"]}
Самолет: ${parsed.baseData["Aircraft"]}
Аэропорт: ${parsed.baseData["Airport"]}
Инженер: ${parsed.baseData["Engineer Name"]}
Вкладка: ${getSheetNameByAircraft(parsed.baseData["Aircraft"])}

🔧 Оборудование (${parsed.equipmentEntries.length}):
${parsed.equipmentEntries.map((item, i) => 
  `${i+1}. ${item.equipment}: ${item.timeIn}-${item.timeOut} (${calculateUsage(item.timeIn, item.timeOut)})`
).join("\n")}`;

      await sendMessage(from, preview);
      await showMainMenu(from);
      session.mode = "menu";
    } catch (error) {
      console.error("Error saving data:", error);
      await sendMessage(from, "Ошибка при сохранении данных. Попробуйте позже.");
    }
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Bot started on port ${process.env.PORT || 3000}`);
});
