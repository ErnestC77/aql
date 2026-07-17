// Pure logic extracted from index.js for testability. No I/O here.

const commandKeywords = ["menu", "меню", "start", "старт", "помощь", "help", "отмена", "cancel"];

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

const aircraftList = [
  "ER-BAS", "ER-BYK", "ER-GAG", "ER-JAN", "ER-HAJ",
  "ER-BOY", "ER-BOS", "ER-UFC", "ER-BCT", "P4-AQQ",
];

const equipmentList = [
  "PAXSTEP", "GPU", "SCISSORLIFT", "NITROGEN", "JACK", "DOLLY",
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

function getSheetNameByAircraft(aircraft) {
  return aircraftSheetMap[aircraft] || DEFAULT_SHEET_NAME;
}

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

function normalizeTimeInput(t) {
  if (!t) return null;

  const value = String(t).trim();

  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(":").map(Number);

    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return null;
    }

    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  if (/^\d{3,4}$/.test(value)) {
    const padded = value.padStart(4, "0");
    const h = Number(padded.slice(0, 2));
    const m = Number(padded.slice(2, 4));

    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return null;
    }

    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  return null;
}

function isValidTime(t) {
  return normalizeTimeInput(t) !== null;
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

function columnToLetter(col) {
  let letter = "";
  let n = col;

  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }

  return letter;
}

function getColumnByField(fieldKey) {
  const item = editableFields.find((f) => f.key === fieldKey);
  return item?.col;
}

// Латиница/кириллица выглядят одинаково на клавиатуре при наборе бортовых
// номеров (ER-BAS) — сопоставляем только визуально неотличимые пары.
const CYRILLIC_TO_LATIN = {
  А: "A", В: "B", Е: "E", К: "K", М: "M",
  Н: "H", О: "O", Р: "P", С: "C", Т: "T",
  У: "Y", Х: "X",
};

function isValidDate(dateText) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(dateText);
  if (!match) return false;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 2000 || year > 2100) return false;

  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function normalizeHomoglyphs(text) {
  return text
    .split("")
    .map((ch) => CYRILLIC_TO_LATIN[ch] || ch)
    .join("");
}

function parseInputLine(text) {
  // Дата вида dd/mm/yyyy иначе ломает разбиение по "/" (разделитель групп оборудования)
  const normalizedText = text.replace(
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
    "$1.$2.$3"
  );

  const parts = normalizedText.split("/").map((p) => p.trim()).filter(Boolean);

  if (parts.length < 2) {
    return {
      ok: false,
      reason: "Не найден разделитель «/» между базовыми данными и оборудованием. Формат: РЕЙС, ДАТА, САМОЛЁТ, АЭРОПОРТ, ИНЖЕНЕР / ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА.",
    };
  }

  const baseParts = parts[0].split(",").map((p) => p.trim());

  if (baseParts.length < 5) {
    return {
      ok: false,
      reason: "Не хватает базовых полей — нужны рейс, дата, самолёт, аэропорт, инженер через запятую.",
    };
  }

  const baseData = {
    Flight: baseParts[0].toUpperCase(),
    Date: baseParts[1],
    Aircraft: normalizeHomoglyphs(baseParts[2].toUpperCase()),
    Airport: normalizeHomoglyphs(baseParts[3].toUpperCase()),
    "Engineer Name": baseParts[4],
  };

  if (!isValidDate(baseData["Date"])) {
    return {
      ok: false,
      reason: `Некорректная дата «${baseData["Date"]}». Формат: ДД.ММ.ГГГГ, например 01.05.2026.`,
    };
  }

  if (!aircraftList.includes(baseData["Aircraft"])) {
    return {
      ok: false,
      reason: `Самолёт «${baseData["Aircraft"]}» не найден. Допустимые: ${aircraftList.join(", ")}.`,
    };
  }

  const equipmentEntries = [];

  for (let i = 1; i < parts.length; i++) {
    const equipParts = parts[i].split(",").map((p) => p.trim());

    if (equipParts.length < 2) {
      return {
        ok: false,
        reason: `Не распознана группа оборудования «${parts[i]}» — нужен формат «ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА[, ВРЕМЯ_ОКОНЧАНИЯ]».`,
      };
    }

    const equipment = equipParts[0].toUpperCase();
    const timeIn = normalizeTimeInput(equipParts[1]);
    const timeOut = equipParts[2] ? normalizeTimeInput(equipParts[2]) : "";

    if (!equipment || !timeIn) {
      return {
        ok: false,
        reason: `Не распознано время начала «${equipParts[1]}» для «${equipment || equipParts[0]}». Используйте 1200, 12:00 и т.п.`,
      };
    }

    if (equipParts[2] && !timeOut) {
      return {
        ok: false,
        reason: `Не распознано время окончания «${equipParts[2]}» для «${equipment}». Используйте 1200, 12:00 и т.п.`,
      };
    }

    equipmentEntries.push({ equipment, timeIn, timeOut });
  }

  if (equipmentEntries.length === 0) {
    return {
      ok: false,
      reason: "Не найдено ни одной группы оборудования после «/».",
    };
  }

  return { ok: true, baseData, equipmentEntries };
}

module.exports = {
  commandKeywords,
  aircraftSheetMap,
  DEFAULT_SHEET_NAME,
  ALL_SHEET_NAMES,
  aircraftList,
  equipmentList,
  editableFields,
  getSheetNameByAircraft,
  short,
  todayDate,
  isCommandKeyword,
  calculateUsage,
  normalizeTimeInput,
  isValidTime,
  parseDateTime,
  extractIncomingText,
  getColumnByField,
  columnToLetter,
  parseInputLine,
};
