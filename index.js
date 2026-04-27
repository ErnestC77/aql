require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const sessions = {};

const SHEET_NAME = "Sheet1";

const aircraftList = [
  "ER-BAS", "ER-BYK", "ER-GAG", "ER-JAN", "ER-HAJ",
  "ER-BOY", "ER-BOS", "ER-UFC", "ER-BCT", "P4-AQQ"
];

const airportList = ["DWC", "HKG", "SHJ", "AUH", "FJR", "SYD"];

const equipmentList = [
  "PAXSTEP", "GPU", "SCISSORLIFT", "NITROGEN", "JACK", "DOLLY"
];

const fields = [
  { key: "Flight", label: "Номер рейса" },
  { key: "Date", label: "Дата" },
  { key: "Equipment / Company", label: "Наземное оборудование / Компания" },
  { key: "Time in", label: "Время начала использования" },
  { key: "Time out", label: "Время окончания использования" },
  { key: "Aircraft", label: "Самолёт" },
  { key: "Airport", label: "Аэропорт" },
  { key: "Engineer Name", label: "Имя инженера" },
];

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
          buttons: buttons.map((btn) => ({
            type: "reply",
            reply: {
              id: btn.id,
              title: btn.title,
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
          button: buttonText,
          sections: [
            {
              title: "Выбор",
              rows: rows.slice(0, 10).map((row) => ({
                id: row.id,
                title: row.title,
                description: row.description || "",
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

async function saveToSheet(data) {
  const sheets = await getSheetsClient();

  const totalUsage = calculateUsage(data["Time in"], data["Time out"]);

  const row = [
    data["Flight"] || "",
    data["Date"] || "",
    data["Equipment / Company"] || "",
    data["Time in"] || "",
    data["Time out"] || "",
    totalUsage,
    data["Aircraft"] || "",
    data["Airport"] || "",
    data["Engineer Name"] || "",
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${SHEET_NAME}'!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function getAllRows() {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${SHEET_NAME}'!A:I`,
  });

  return res.data.values || [];
}

async function getRowsLast24Hours() {
  const rows = await getAllRows();
  const now = new Date();
  const last24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const found = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowDate = parseDateTime(row[1], row[3]);

    if (rowDate && rowDate >= last24 && rowDate <= now) {
      found.push({
        rowNumber: i + 1,
        row,
      });
    }
  }

  return found.reverse();
}

async function updateCell(rowNumber, columnNumber, value) {
  const sheets = await getSheetsClient();
  const columnLetter = String.fromCharCode(64 + columnNumber);

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${SHEET_NAME}'!${columnLetter}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[value]],
    },
  });
}

async function showMainMenu(to) {
  await sendButtons(to, "Выберите действие:", [
    { id: "ADD", title: "Внести данные" },
    { id: "EDIT", title: "Редактировать" },
  ]);
}

async function askCurrentField(to, session) {
  const field = fields[session.step];

  if (field.key === "Date") {
    await sendButtons(to, "Выберите дату:", [
      { id: "DATE_TODAY", title: "Сегодня" },
      { id: "DATE_MANUAL", title: "Ввести дату" },
    ]);
    return;
  }

  if (field.key === "Equipment / Company") {
    const rows = equipmentList.map((e) => ({
      id: `EQUIPMENT_${e}`,
      title: e,
    }));

    rows.push({ id: "EQUIPMENT_MANUAL", title: "Ввести вручную" });

    await sendList(to, "Выберите наземное оборудование:", "Выбрать", rows);
    return;
  }

  if (field.key === "Time in") {
    await sendMessage(to, "Введите время начала использования вручную, например 10:20:");
    return;
  }

  if (field.key === "Time out") {
    await sendButtons(to, "Введите время окончания использования или пропустите:", [
      { id: "TIME_OUT_SKIP", title: "Пропустить" },
      { id: "TIME_OUT_ENTER", title: "Ввести время" },
    ]);
    return;
  }

  if (field.key === "Aircraft") {
    await sendList(
      to,
      "Выберите самолёт:",
      "Выбрать",
      aircraftList.map((a) => ({ id: `AIRCRAFT_${a}`, title: a }))
    );
    return;
  }

  if (field.key === "Airport") {
    const rows = airportList.map((a) => ({ id: `AIRPORT_${a}`, title: a }));
    rows.push({ id: "AIRPORT_MANUAL", title: "Ввести вручную" });

    await sendList(to, "Выберите аэропорт:", "Выбрать", rows);
    return;
  }

  await sendMessage(to, `Введите: ${field.label}`);
}

function buildPreview(data) {
  const totalUsage = calculateUsage(data["Time in"], data["Time out"]);

  return `Проверьте данные:

Номер рейса: ${data["Flight"] || ""}
Дата: ${data["Date"] || ""}
Наземное оборудование / Компания: ${data["Equipment / Company"] || ""}
Время начала использования: ${data["Time in"] || ""}
Время окончания использования: ${data["Time out"] || "не указано"}
Общее время использования: ${totalUsage || "будет рассчитано после ввода окончания"}
Самолёт: ${data["Aircraft"] || ""}
Аэропорт: ${data["Airport"] || ""}
Имя инженера: ${data["Engineer Name"] || ""}`;
}

async function finishAddFlow(from, session) {
  if (session.step < fields.length) {
    await askCurrentField(from, session);
    return;
  }

  session.mode = "confirm";

  await sendButtons(from, `${buildPreview(session.data)}

Сохранить?`, [
    { id: "SAVE_YES", title: "Да" },
    { id: "SAVE_NO", title: "Нет" },
  ]);
}

function getColumnByField(fieldKey) {
  const map = {
    "Flight": 1,
    "Date": 2,
    "Equipment / Company": 3,
    "Time in": 4,
    "Time out": 5,
    "Aircraft": 7,
    "Airport": 8,
    "Engineer Name": 9,
  };

  return map[fieldKey];
}

async function recalculateTotalUsage(rowNumber) {
  const rows = await getAllRows();
  const row = rows[rowNumber - 1];

  const totalUsage = calculateUsage(row[3], row[4]);
  await updateCell(rowNumber, 6, totalUsage);
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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = extractIncomingText(message);
    if (!text) return;

    if (!sessions[from]) {
      sessions[from] = { mode: "menu", step: 0, data: {} };
      await showMainMenu(from);
      return;
    }

    const session = sessions[from];

    if (text.toLowerCase() === "menu" || text.toLowerCase() === "меню") {
      sessions[from] = { mode: "menu", step: 0, data: {} };
      await showMainMenu(from);
      return;
    }

    if (session.mode === "menu") {
      if (text === "ADD") {
        session.mode = "add";
        session.step = 0;
        session.data = {};
        await askCurrentField(from, session);
        return;
      }

      if (text === "EDIT") {
        const found = await getRowsLast24Hours();

        if (found.length === 0) {
          await sendMessage(from, "За последние 24 часа записи не найдены.");
          await showMainMenu(from);
          return;
        }

        session.mode = "edit_choose_record";
        session.found = found;

        const listRows = found.slice(0, 10).map((item, index) => ({
          id: `EDIT_RECORD_${index}`,
          title: `${item.row[0]} | ${item.row[1]}`,
          description: `${item.row[3] || ""}-${item.row[4] || "не окончено"} | ${item.row[6] || ""} | ${item.row[7] || ""}`,
        }));

        await sendList(from, "Записи за последние 24 часа:", "Выбрать", listRows);
        return;
      }

      await showMainMenu(from);
      return;
    }

    if (session.mode === "add") {
      const field = fields[session.step];

      if (text.startsWith("EQUIPMENT_")) {
        const equipment = text.replace("EQUIPMENT_", "");

        if (equipment === "MANUAL") {
          session.mode = "add_manual_equipment";
          await sendMessage(from, "Введите наземное оборудование / компанию вручную:");
          return;
        }

        session.data["Equipment / Company"] = equipment;
        session.step++;
        await finishAddFlow(from, session);
        return;
      }

      if (text === "DATE_TODAY") {
        session.data["Date"] = todayDate();
      } else if (text === "DATE_MANUAL") {
        session.mode = "add_manual_date";
        await sendMessage(from, "Введите дату вручную, например 27.04.2026:");
        return;
      } else if (text === "TIME_OUT_SKIP") {
        session.data["Time out"] = "";
      } else if (text === "TIME_OUT_ENTER") {
        session.mode = "add_time_out_manual";
        await sendMessage(from, "Введите время окончания использования, например 12:45:");
        return;
      } else if (text.startsWith("AIRCRAFT_")) {
        session.data["Aircraft"] = text.replace("AIRCRAFT_", "");
      } else if (text.startsWith("AIRPORT_")) {
        const airport = text.replace("AIRPORT_", "");

        if (airport === "MANUAL") {
          session.mode = "add_manual_airport";
          await sendMessage(from, "Введите аэропорт вручную:");
          return;
        }

        session.data["Airport"] = airport;
      } else {
        session.data[field.key] = text;
      }

      session.step++;
      await finishAddFlow(from, session);
      return;
    }

    if (session.mode === "add_manual_equipment") {
      session.data["Equipment / Company"] = text.toUpperCase();
      session.mode = "add";
      session.step++;
      await finishAddFlow(from, session);
      return;
    }

    if (session.mode === "add_manual_date") {
      session.data["Date"] = text;
      session.mode = "add";
      session.step++;
      await finishAddFlow(from, session);
      return;
    }

    if (session.mode === "add_time_out_manual") {
      session.data["Time out"] = text;
      session.mode = "add";
      session.step++;
      await finishAddFlow(from, session);
      return;
    }

    if (session.mode === "add_manual_airport") {
      session.data["Airport"] = text.toUpperCase();
      session.mode = "add";
      session.step++;
      await finishAddFlow(from, session);
      return;
    }

    if (session.mode === "confirm") {
      if (text === "SAVE_YES") {
        await saveToSheet(session.data);
        sessions[from] = { mode: "menu", step: 0, data: {} };

        await sendMessage(from, "Данные сохранены в Google таблицу.");
        await showMainMenu(from);
        return;
      }

      if (text === "SAVE_NO") {
        sessions[from] = { mode: "menu", step: 0, data: {} };
        await sendMessage(from, "Запись отменена.");
        await showMainMenu(from);
        return;
      }
    }

    if (session.mode === "edit_choose_record") {
      const index = Number(text.replace("EDIT_RECORD_", ""));
      session.editRecord = session.found[index];

      session.mode = "edit_choose_field";

      await sendList(
        from,
        "Что изменить?",
        "Выбрать поле",
        fields.map((f, i) => ({
          id: `EDIT_FIELD_${i}`,
          title: f.label,
        }))
      );

      return;
    }

    if (session.mode === "edit_choose_field") {
      const fieldIndex = Number(text.replace("EDIT_FIELD_", ""));
      session.editField = fields[fieldIndex];

      await sendMessage(from, `Введите новое значение: ${session.editField.label}`);
      session.mode = "edit_enter_value";
      return;
    }

    if (session.mode === "edit_enter_value") {
      const rowNumber = session.editRecord.rowNumber;
      const columnNumber = getColumnByField(session.editField.key);

      await updateCell(rowNumber, columnNumber, text);

      if (session.editField.key === "Time in" || session.editField.key === "Time out") {
        await recalculateTotalUsage(rowNumber);
      }

      sessions[from] = { mode: "menu", step: 0, data: {} };

      await sendMessage(from, "Запись обновлена.");
      await showMainMenu(from);
      return;
    }
  } catch (error) {
    console.log("ERROR:", error.response?.data || error.message);
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Bot started on port ${process.env.PORT}`);
});