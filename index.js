require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const sessions = {};
const SESSION_TTL = 60 * 60 * 1000; // 1 hour

// Periodically purge stale sessions
setInterval(() => {
  const now = Date.now();
  for (const phone in sessions) {
    if (now - (sessions[phone].lastActive || 0) > SESSION_TTL) {
      delete sessions[phone];
    }
  }
}, 10 * 60 * 1000); // run every 10 minutes

// =====================
// Cache & Constants
// =====================
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const sheetCache = new Map();
const commandKeywords = ["menu", "меню", "start", "старт"];

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

// Pre-mapped lists to reduce runtime processing
const flightListMapped = flightList.map((f) => ({
  id: `FLIGHT_${f}`,
  title: f,
}));

const aircraftListMapped = aircraftList.map((a) => ({
  id: `AIRCRAFT_${a}`,
  title: a,
  description: getSheetNameByAircraft(a),
}));

const airportListMapped = airportList.map((a) => ({
  id: `AIRPORT_${a}`,
  title: a,
}));

// WhatsApp number -> Engineer name
const engineerByPhone = {
  "79191534499": "Badrutdinov Ernest",
  "99364027397": "Yoldashov Rustam",
};

function getEngineerNameByPhone(phone) {
  return engineerByPhone[phone] || phone;
}

const baseFields = [
  { key: "Flight", label: "Номер рейса" },
  { key: "Date", label: "Дата" },
  { key: "Aircraft", label: "Самолёт" },
  { key: "Airport", label: "Аэропорт" },
  { key: "Engineer Name", label: "Имя и фамилия инженера" },
];

const editableFields = [
  { key: "Flight", label: "Номер рейса", col: 1 },
  { key: "Date", label: "Дата", col: 2 },
  { key: "Equipment / Company", label: "Оборудование", col: 3 },
  { key: "Time in", label: "Время начала", col: 4 },
  { key: "Time out", label: "Время окончания", col: 5 },
  { key: "Aircraft", label: "Самолёт", col: 7 },
  { key: "Aircraft Registration", label: "Регистрация борта", col: 6 },
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

    // Invalidate cache after write
    sheetCache.delete(sheetName);
  } catch (error) {
    console.error("Error saving rows to sheet:", error);
    throw error;
  }
}

async function getAllRowsFromSheet(sheetName) {
  try {
    // Check cache first
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
    
    // Store in cache
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

        // Column K (index 11) = WhatsApp number of creator
        if (row[11] !== createdBy) continue;
        
        // Column L (index 12) = created date/time
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

    // Invalidate cache
    sheetCache.delete(sheetName);
  } catch (error) {
    console.error("Error updating cell:", error);
    throw error;
  }
}

async function recalculateTotalUsage(sheetName, rowNumber, timeIn, timeOut) {
  try {
    let resolvedTimeIn = timeIn;
    let resolvedTimeOut = timeOut;

    // Only fetch from sheet if not provided
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
// UI
// =====================
async function showWelcomeMessage(to) {
  await sendMessage(
    to,
    `Здравствуйте! 👋

Этот бот предназначен для внесения данных по наземному оборудованию в Google Sheet.

Что можно делать:
1. Внести данные — создать новую запись.
2. Редактировать — изменить свою последнюю запись.
3. Дополнить — добавить время окончания, если оно было пропущено.

Для возврата в меню в любой момент напишите: menu`
  );
}

async function showMainMenu(to) {
  await sendButtons(to, "Главное меню:", [
    { id: "ADD", title: "Внести данные" },
    { id: "EDIT", title: "Редактировать" },
    { id: "FILL_MISSING", title: "Дополнить" },
  ]);
}

async function goToMainMenu(from) {
  sessions[from] = {
    mode: "menu",
    step: 0,
    baseData: {},
    equipmentEntries: [],
    currentEquipment: null,
    lastActive: Date.now(),
  };

  await showMainMenu(from);
}

async function askBaseField(to, session) {
  const field = baseFields[session.step];

  if (field.key === "Flight") {
    const rows = [...flightListMapped, { id: "FLIGHT_MANUAL", title: "Ввести вручную" }];
    await sendList(to, "Выберите номер рейса:", "Выбрать", rows);
    return;
  }

  if (field.key === "Date") {
    await sendButtons(to, "Выберите дату:", [
      { id: "DATE_TODAY", title: "Сегодня" },
      { id: "DATE_MANUAL", title: "Ввести дату" },
      { id: "MAIN_MENU", title: "Главное меню" },
    ]);
    return;
  }

  if (field.key === "Aircraft") {
    await sendList(to, "Выберите самолёт:", "Выбрать", aircraftListMapped);
    return;
  }

  if (field.key === "Airport") {
    const rows = [...airportListMapped, { id: "AIRPORT_MANUAL", title: "Ввести вручную" }];
    await sendList(to, "Выберите аэропорт:", "Выбрать", rows);
    return;
  }

  if (field.key === "Engineer Name") {
    await sendMessage(to, "Введите имя и фамилию инженера:");
    return;
  }

  await sendMessage(to, `Введите: ${field.label}`);
}

async function askEquipment(to, session) {
  const selected = (session.equipmentEntries || []).map((item) => item.equipment);
  const available = equipmentList.filter((e) => !selected.includes(e));

  if (available.length === 0) {
    session.mode = "confirm";

    await sendButtons(to, `${buildPreview(session.baseData, session.equipmentEntries)}

Все виды оборудования уже выбраны.

Сохранить?`, [
      { id: "SAVE_YES", title: "Да" },
      { id: "SAVE_NO", title: "Нет" },
      { id: "MAIN_MENU", title: "Главное меню" },
    ]);

    return;
  }

  const rows = available.map((e) => ({
    id: `EQUIPMENT_${e}`,
    title: e,
  }));

  rows.push({ id: "EQUIPMENT_MANUAL", title: "Ввести вручную" });

  await sendList(to, "Выберите наземное оборудование:", "Выбрать", rows);
}

function buildPreview(baseData, equipmentEntries) {
  const equipmentText = equipmentEntries.map((item, index) => {
    const total = calculateUsage(item.timeIn, item.timeOut);

    return `${index + 1}. ${item.equipment}
Начало: ${item.timeIn || ""}
Окончание: ${item.timeOut || "не указано"}
Общее время: ${total || "будет позже"}`;
  }).join("\n\n");

  return `Проверьте данные:

Номер рейса: ${baseData["Flight"] || ""}
Дата: ${baseData["Date"] || ""}
Самолёт: ${baseData["Aircraft"] || ""}
Аэропорт: ${baseData["Airport"] || ""}
Имя инженера: ${baseData["Engineer Name"] || ""}
Вкладка: ${getSheetNameByAircraft(baseData["Aircraft"])}

Оборудование:
${equipmentText}`;
}

async function finishBaseFlow(from, session) {
  if (session.step < baseFields.length) {
    await askBaseField(from, session);
    return;
  }

  session.mode = "equipment_choose";
  await askEquipment(from, session);
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

async function showMissingRecords(from, session) {
  try {
    const rows = await getLast10Rows(from);

    const missing = rows.filter((item) => {
      const row = item.row;
      return row[3] && !row[4];
    });

    if (missing.length === 0) {
      await sendMessage(from, "Незаполненных записей среди последних 10 записей нет.");
      await goToMainMenu(from);
      return;
    }

    session.mode = "missing_choose_record";
    session.missing = missing;

    const listRows = missing.slice(0, 10).map((item, index) => ({
      id: `MISSING_RECORD_${index}`,
      title: short(`${item.row[2]} ${item.row[3]}`, 24),
      description: short(`${item.sheetName} | Рейс: ${item.row[0] || ""} | ${item.row[7] || ""} | ${item.row[8] || ""}`, 72),
    }));

    await sendList(
      from,
      "Выберите оборудование, где не заполнено время окончания:",
      "Выбрать",
      listRows
    );
  } catch (error) {
    console.error("Error showing missing records:", error);
    await sendMessage(from, "Ошибка при загрузке записей. Напишите menu.");
  }
}

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
        step: 0,
        baseData: {},
        equipmentEntries: [],
        currentEquipment: null,
        lastActive: Date.now(),
      };

      // Check for menu command on first message
      if (isCommandKeyword(text)) {
        await showMainMenu(from);
      }
      return;
    }

    const session = sessions[from];
    session.lastActive = Date.now();

    // Global menu command check
    if (text === "MAIN_MENU" || isCommandKeyword(text)) {
      await goToMainMenu(from);
      return;
    }

    if (text === "FILL_MISSING") {
      await showMissingRecords(from, session);
      return;
    }

    // Menu mode
    if (session.mode === "menu") {
      if (text === "ADD") {
        session.mode = "base";
        session.step = 0;
        session.baseData = {};
        session.equipmentEntries = [];
        session.currentEquipment = null;

        await askBaseField(from, session);
        return;
      }

      if (text === "EDIT") {
        try {
          const found = await getLast10Rows(from);

          if (found.length === 0) {
            await sendMessage(from, "Последние записи не найдены.");
            await showMainMenu(from);
            return;
          }

          session.mode = "edit_choose_record";
          session.found = found;

          const listRows = found.slice(0, 10).map((item, index) => ({
            id: `EDIT_RECORD_${index}`,
            title: short(`${item.row[0]} ${item.row[2]}`, 24),
            description: short(`${item.sheetName} | ${item.row[3] || ""}-${item.row[4] || "не окончено"} | ${item.row[7] || ""} | ${item.row[8] || ""}`, 72),
          }));

          await sendList(from, "Последние 10 записей:", "Выбрать", listRows);
        } catch (error) {
          console.error("Error in EDIT mode:", error);
          await sendMessage(from, "Ошибка при загрузке записей.");
          await showMainMenu(from);
        }
        return;
      }

      await showMainMenu(from);
      return;
    }

    // Base data collection mode
    if (session.mode === "base") {
      const field = baseFields[session.step];

      if (text.startsWith("FLIGHT_")) {
        const flight = text.replace("FLIGHT_", "");

        if (flight === "MANUAL") {
          session.mode = "base_manual_flight";
          await sendMessage(from, "Введите номер рейса вручную:");
          return;
        }

        session.baseData["Flight"] = flight;
        session.step++;
        await finishBaseFlow(from, session);
        return;
      }

      if (text === "DATE_TODAY") {
        session.baseData["Date"] = todayDate();
      } else if (text === "DATE_MANUAL") {
        session.mode = "base_manual_date";
        await sendMessage(from, "Введите дату вручную, например 27.04.2026:");
        return;
      } else if (text.startsWith("AIRCRAFT_")) {
        session.baseData["Aircraft"] = text.replace("AIRCRAFT_", "");
      } else if (text.startsWith("AIRPORT_")) {
        const airport = text.replace("AIRPORT_", "");

        if (airport === "MANUAL") {
          session.mode = "base_manual_airport";
          await sendMessage(from, "Введите аэропорт вручную:");
          return;
        }

        session.baseData["Airport"] = airport;
      } else {
        session.baseData[field.key] = text;
      }

      session.step++;
      await finishBaseFlow(from, session);
      return;
    }

    if (session.mode === "base_manual_flight") {
      session.baseData["Flight"] = text.toUpperCase();
      session.mode = "base";
      session.step++;
      await finishBaseFlow(from, session);
      return;
    }

    if (session.mode === "base_manual_date") {
      session.baseData["Date"] = text;
      session.mode = "base";
      session.step++;
      await finishBaseFlow(from, session);
      return;
    }

    if (session.mode === "base_manual_airport") {
      session.baseData["Airport"] = text.toUpperCase();
      session.mode = "base";
      session.step++;
      await finishBaseFlow(from, session);
      return;
    }

    // Equipment selection and time entry
    if (session.mode === "equipment_choose") {
      let equipment = "";

      if (text.startsWith("EQUIPMENT_")) {
        equipment = text.replace("EQUIPMENT_", "");

        if (equipment === "MANUAL") {
          session.mode = "equipment_manual";
          await sendMessage(from, "Введите название оборудования вручную:");
          return;
        }
      } else {
        equipment = text.toUpperCase();
      }

      session.currentEquipment = {
        equipment,
        timeIn: "",
        timeOut: "",
      };

      session.mode = "equipment_time_in";
      await sendMessage(from, `Введите время начала использования для ${equipment}, например 10:20:`);
      return;
    }

    if (session.mode === "equipment_manual") {
      const equipment = text.toUpperCase();

      session.currentEquipment = {
        equipment,
        timeIn: "",
        timeOut: "",
      };

      session.mode = "equipment_time_in";
      await sendMessage(from, `Введите время начала использования для ${equipment}, например 10:20:`);
      return;
    }

    if (session.mode === "equipment_time_in") {
      if (!isValidTime(text)) {
        await sendMessage(from, "Неверный формат. Введите время как 10:20:");
        return;
      }
      session.currentEquipment.timeIn = text;

      session.mode = "equipment_time_out_choice";
      await sendButtons(from, `Время окончания для ${session.currentEquipment.equipment}:`, [
        { id: "TIME_OUT_ENTER", title: "Ввести" },
        { id: "TIME_OUT_SKIP", title: "Пропустить" },
        { id: "MAIN_MENU", title: "Главное меню" },
      ]);
      return;
    }

    if (session.mode === "equipment_time_out_choice") {
      if (text === "TIME_OUT_SKIP") {
        session.currentEquipment.timeOut = "";
        session.equipmentEntries.push(session.currentEquipment);
        session.currentEquipment = null;

        session.mode = "add_more_equipment";
        await sendButtons(from, "Добавить ещё оборудование?", [
          { id: "ADD_MORE_YES", title: "Да" },
          { id: "ADD_MORE_NO", title: "Нет" },
          { id: "MAIN_MENU", title: "Главное меню" },
        ]);
        return;
      }

      if (text === "TIME_OUT_ENTER") {
        session.mode = "equipment_time_out_enter";
        await sendMessage(from, "Введите время окончания, например 12:45:");
        return;
      }

      await sendButtons(from, "Выберите действие:", [
        { id: "TIME_OUT_ENTER", title: "Ввести" },
        { id: "TIME_OUT_SKIP", title: "Пропустить" },
        { id: "MAIN_MENU", title: "Главное меню" },
      ]);
      return;
    }

    if (session.mode === "equipment_time_out_enter") {
      if (!isValidTime(text)) {
        await sendMessage(from, "Неверный формат. Введите время как 12:45:");
        return;
      }
      session.currentEquipment.timeOut = text;
      session.equipmentEntries.push(session.currentEquipment);
      session.currentEquipment = null;

      session.mode = "add_more_equipment";
      await sendButtons(from, "Добавить ещё оборудование?", [
        { id: "ADD_MORE_YES", title: "Да" },
        { id: "ADD_MORE_NO", title: "Нет" },
        { id: "MAIN_MENU", title: "Главное меню" },
      ]);
      return;
    }

    if (session.mode === "add_more_equipment") {
      if (text === "ADD_MORE_YES") {
        session.mode = "equipment_choose";
        await askEquipment(from, session);
        return;
      }

      if (text === "ADD_MORE_NO") {
        session.mode = "confirm";

        await sendButtons(from, `${buildPreview(session.baseData, session.equipmentEntries)}

Сохранить?`, [
          { id: "SAVE_YES", title: "Да" },
          { id: "SAVE_NO", title: "Нет" },
          { id: "MAIN_MENU", title: "Главное меню" },
        ]);
        return;
      }

      await sendButtons(from, "Добавить ещё оборудование?", [
        { id: "ADD_MORE_YES", title: "Да" },
        { id: "ADD_MORE_NO", title: "Нет" },
        { id: "MAIN_MENU", title: "Главное меню" },
      ]);
      return;
    }

    if (session.mode === "confirm") {
      if (text === "SAVE_YES") {
        if (!session.equipmentEntries || session.equipmentEntries.length === 0) {
          await sendMessage(from, "Нет оборудования для сохранения.");
          await goToMainMenu(from);
          return;
        }

        try {
          const hasMissingTimeOut = session.equipmentEntries.some((item) => !item.timeOut);

          await saveRowsToSheet(session.baseData, session.equipmentEntries, from);
          await sendMessage(from, `Данные сохранены. Вкладка: ${getSheetNameByAircraft(session.baseData["Aircraft"])}.`);

          if (hasMissingTimeOut) {
            await sendButtons(from, "Есть незаполненное время окончания.", [
              { id: "FILL_MISSING", title: "Ввести данные" },
              { id: "MAIN_MENU", title: "Главное меню" },
            ]);
            return;
          }

          await goToMainMenu(from);
        } catch (error) {
          console.error("Error saving data:", error);
          await sendMessage(from, "Ошибка при сохранении. Попробуйте позже.");
          await goToMainMenu(from);
        }
        return;
      }

      if (text === "SAVE_NO") {
        await sendMessage(from, "Запись отменена.");
        await goToMainMenu(from);
        return;
      }

      await sendButtons(from, "Сохранить?", [
        { id: "SAVE_YES", title: "Да" },
        { id: "SAVE_NO", title: "Нет" },
        { id: "MAIN_MENU", title: "Главное меню" },
      ]);
      return;
    }

    if (session.mode === "missing_choose_record") {
      const index = Number(text.replace("MISSING_RECORD_", ""));

      if (isNaN(index) || !session.missing || !session.missing[index]) {
        await sendMessage(from, "Запись не найдена. Напишите menu.");
        return;
      }

      session.missingRecord = session.missing[index];
      session.mode = "missing_enter_time_out";

      const row = session.missingRecord.row;

      await sendMessage(from, `Вы выбрали:
Вкладка: ${session.missingRecord.sheetName}
Оборудование: ${row[2] || ""}
Рейс: ${row[0] || ""}
Дата: ${row[1] || ""}
Начало: ${row[3] || ""}
Борт: ${row[7] || ""}
Аэропорт: ${row[8] || ""}

Введите время окончания, например 12:45:`);

      return;
    }

    if (session.mode === "missing_enter_time_out") {
      if (!isValidTime(text)) {
        await sendMessage(from, "Неверный формат. Введите время как 12:45:");
        return;
      }
      try {
        const sheetName = session.missingRecord.sheetName;
        const rowNumber = session.missingRecord.rowNumber;

        await updateCell(sheetName, rowNumber, 5, text);
        await recalculateTotalUsage(sheetName, rowNumber, session.missingRecord.row[3], text);

        await sendMessage(from, "Время окончания добавлено. Общее время пересчитано.");
        await goToMainMenu(from);
      } catch (error) {
        console.error("Error updating missing time:", error);
        await sendMessage(from, "Ошибка при обновлении. Попробуйте позже.");
        await goToMainMenu(from);
      }
      return;
    }

    if (session.mode === "edit_choose_record") {
      const index = Number(text.replace("EDIT_RECORD_", ""));

      if (isNaN(index) || !session.found || !session.found[index]) {
        await sendMessage(from, "Запись не найдена. Напишите menu.");
        return;
      }

      session.editRecord = session.found[index];
      session.mode = "edit_choose_field";

      await sendList(
        from,
        `Что изменить?
Вкладка: ${session.editRecord.sheetName}`,
        "Выбрать поле",
        editableFields.map((f, i) => ({
          id: `EDIT_FIELD_${i}`,
          title: short(f.label),
        }))
      );

      return;
    }

    if (session.mode === "edit_choose_field") {
      const fieldIndex = Number(text.replace("EDIT_FIELD_", ""));

      if (isNaN(fieldIndex) || !editableFields[fieldIndex]) {
        await sendMessage(from, "Поле не найдено. Попробуйте снова или напишите menu.");
        return;
      }

      session.editField = editableFields[fieldIndex];

      await sendMessage(from, `Введите новое значение: ${session.editField.label}`);
      session.mode = "edit_enter_value";
      return;
    }

    if (session.mode === "edit_enter_value") {
      try {
        const sheetName = session.editRecord.sheetName;
        const rowNumber = session.editRecord.rowNumber;
        const columnNumber = getColumnByField(session.editField.key);

        if (!columnNumber) {
          await sendMessage(from, "Ошибка выбора колонки. Напишите menu.");
          return;
        }

        await updateCell(sheetName, rowNumber, columnNumber, text);

        if (session.editField.key === "Time in" || session.editField.key === "Time out") {
          const row = session.editRecord.row;
          const newTimeIn = session.editField.key === "Time in" ? text : row[3];
          const newTimeOut = session.editField.key === "Time out" ? text : row[4];
          await recalculateTotalUsage(sheetName, rowNumber, newTimeIn, newTimeOut);
        }

        await sendMessage(from, "Запись обновлена.");
        await goToMainMenu(from);
      } catch (error) {
        console.error("Error updating record:", error);
        await sendMessage(from, "Ошибка при обновлении. Попробуйте позже.");
        await goToMainMenu(from);
      }
      return;
    }

    // ✅ Proper error handling - don't break the flow
    console.warn(`Unexpected input in mode "${session.mode}": "${text}"`);
    await sendMessage(from, "Не понимаю. Напишите 'menu' для возврата в главное меню.");
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Bot started on port ${process.env.PORT || 3000}`);
});
