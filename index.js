require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const sessions = {};

// Самолёт -> вкладка Google Sheet
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

const aircraftList = [
  "ER-BAS", "ER-BYK", "ER-GAG", "ER-JAN", "ER-HAJ",
  "ER-BOY", "ER-BOS", "ER-UFC", "ER-BCT", "P4-AQQ"
];

const airportList = ["DWC", "HKG", "SHJ", "AUH", "FJR", "SYD"];

const equipmentList = [
  "PAXSTEP", "GPU", "SCISSORLIFT", "NITROGEN", "JACK", "DOLLY"
];

const flightList = [
  "TVR4701", "TVR4702", "TVR4703", "TVR4704",
  "TVR4707", "TVR4716", "TVR4717"
];

const baseFields = [
  { key: "Flight", label: "Номер рейса" },
  { key: "Date", label: "Дата" },
  { key: "CombinedInfo", label: "Самолёт, аэропорт, инженер" },
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

function short(text, max = 24) {
  if (!text) return "";
  return text.length > max ? text.substring(0, max - 3) + "..." : text;
}

async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function todayDate() {
  return new Date().toLocaleDateString("ru-RU");
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

function parseDateTime(dateText, timeText) {
  if (!dateText || !timeText) return null;

  const [day, month, year] = dateText.split(".").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);

  if (!day || !month || !year || isNaN(hour) || isNaN(minute)) return null;

  return new Date(year, month - 1, day, hour, minute);
}

async function sendMessage(to, text) {
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
    }
  );
}

async function sendButtons(to, body, buttons) {
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
    }
  );
}

async function sendList(to, body, buttonText, rows) {
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
    }
  );
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

async function saveRowsToSheet(baseData, equipmentEntries) {
  const sheets = await getSheetsClient();
  const sheetName = getSheetNameByAircraft(baseData["Aircraft"]);

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
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

async function getAllRowsFromSheet(sheetName) {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A:I`,
  });

  return res.data.values || [];
}

async function getLast10Rows()const found = [];

  for (const sheetName of ALL_SHEET_NAMES) {
    const rows = await getAllRowsFromSheet(sheetName);

    for (let i = 1; i < rows.length; i++) {
      found.push({
        sheetName,
        rowNumber: i + 1,
        row: rows[i],
      });
    }
  }

  return found.slice(-10).reverse();
}

async function updateCell(sheetName, rowNumber, columnNumber, value) {
  const sheets = await getSheetsClient();
  const columnLetter = String.fromCharCode(64 + columnNumber);

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!${columnLetter}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

async function recalculateTotalUsage(sheetName, rowNumber) {
  const rows = await getAllRowsFromSheet(sheetName);
  const row = rows[rowNumber - 1];

  const totalUsage = calculateUsage(row[3], row[4]);
  await updateCell(sheetName, rowNumber, 6, totalUsage);
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
  };

  await showMainMenu(from);
}

async function askBaseField(to, session) {
  const field = baseFields[session.step];

  if (field.key === "Flight") {
    const rows = flightList.map((f) => ({
      id: `FLIGHT_${f}`,
      title: f,
    }));

    rows.push({ id: "FLIGHT_MANUAL", title: "Ввести вручную" });

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

  if (field.key === "CombinedInfo") {
    await sendMessage(
      to,
      "Введите самолёт, аэропорт и инженера одним сообщением:\n\nПример:\nER-BAS, SHJ, Gromov R."
    );
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
  const rows = await getLast10Rows();

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
    description: short(`${item.sheetName} | Рейс: ${item.row[0] || ""} | ${item.row[6] || ""} | ${item.row[7] || ""} | ${item.row[8] || ""}`, 72),
  }));

  await sendList(
    from,
    "Выберите оборудование, где не заполнено время окончания:",
    "Выбрать",
    listRows
  );
}

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
        step: 0,
        baseData: {},
        equipmentEntries: [],
        currentEquipment: null,
      };

      await showMainMenu(from);
      return;
    }

    const session = sessions[from];

    if (text === "FILL_MISSING") {
      await showMissingRecords(from, session);
      return;
    }

    if (
      text === "MAIN_MENU" ||
      text.toLowerCase() === "menu" ||
      text.toLowerCase() === "меню" ||
      text.toLowerCase() === "start" ||
      text.toLowerCase() === "старт"
    ) {
      await goToMainMenu(from);
      return;
    }

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
        const found = await getLast10Rows();

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
          description: short(`${item.sheetName} | ${item.row[3] || ""}-${item.row[4] || "не окончено"} | ${item.row[6] || ""} | ${item.row[7] || ""} | ${item.row[8] || ""}`, 72),
        }));

        await sendList(from, "Последние 10 записей:", "Выбрать", listRows);
        return;
      }

      await showMainMenu(from);
      return;
    }

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
      } else if (field.key === "CombinedInfo") {
        const parts = text.split(",").map((x) => x.trim());

        if (parts.length < 3) {
          await sendMessage(from, "Введите в формате:\nСамолёт, Аэропорт, Инженер\n\nПример:\nER-BAS, SHJ, Ernest");
          return;
        }

        session.baseData["Aircraft"] = parts[0].toUpperCase();
        session.baseData["Airport"] = parts[1].toUpperCase();
        session.baseData["Engineer Name"] = parts.slice(2).join(" ");
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

        const hasMissingTimeOut = session.equipmentEntries.some((item) => !item.timeOut);

        await saveRowsToSheet(session.baseData, session.equipmentEntries);
        await sendMessage(from, `Данные сохранены в Google таблицу, вкладка: ${getSheetNameByAircraft(session.baseData["Aircraft"])}.`);

        if (hasMissingTimeOut) {
          await sendButtons(from, "Есть незаполненное время окончания.", [
            { id: "FILL_MISSING", title: "Ввести данные" },
            { id: "MAIN_MENU", title: "Главное меню" },
          ]);
          return;
        }

        await goToMainMenu(from);
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
Борт: ${row[6] || ""}
Аэропорт: ${row[7] || ""}

Введите время окончания, например 12:45:`);

      return;
    }

    if (session.mode === "missing_enter_time_out") {
      const sheetName = session.missingRecord.sheetName;
      const rowNumber = session.missingRecord.rowNumber;

      await updateCell(sheetName, rowNumber, 5, text);
      await recalculateTotalUsage(sheetName, rowNumber);

      await sendMessage(from, "Время окончания добавлено. Общее время пересчитано.");
      await goToMainMenu(from);
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
        `Что изменить?\nВкладка: ${session.editRecord.sheetName}`,
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
      const sheetName = session.editRecord.sheetName;
      const rowNumber = session.editRecord.rowNumber;
      const columnNumber = getColumnByField(session.editField.key);

      if (!columnNumber) {
        await sendMessage(from, "Ошибка выбора колонки. Напишите menu.");
        return;
      }

      await updateCell(sheetName, rowNumber, columnNumber, text);

      if (session.editField.key === "Time in" || session.editField.key === "Time out") {
        await recalculateTotalUsage(sheetName, rowNumber);
      }

      await sendMessage(from, "Запись обновлена.");
      await goToMainMenu(from);
      return;
    }

    await showMainMenu(from);
  } catch (error) {
    console.log("ERROR:", error.response?.data || error.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Bot started on port ${process.env.PORT || 3000}`);
});
