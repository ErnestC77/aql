const { google } = require("googleapis");
const lib = require("./lib");

const CACHE_TTL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 15000;

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

// client: googleapis sheets client (real or fake, same shape) — injected for testability
function createSheetsService(client, spreadsheetId) {
  const cache = new Map();

  async function getSheetIdByName(sheetName) {
    const res = await client.spreadsheets.get({
      spreadsheetId,
      timeout: REQUEST_TIMEOUT,
    });

    const sheet = res.data.sheets.find((s) => s.properties.title === sheetName);
    // null означает "не найдено" — 0 является настоящим валидным sheetId,
    // поэтому его нельзя использовать как sentinel для "не найдено".
    return sheet ? sheet.properties.sheetId : null;
  }

  async function getAllRowsFromSheet(sheetName) {
    const cached = cache.get(sheetName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    const res = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!A:M`,
      timeout: REQUEST_TIMEOUT,
    });

    const data = res.data.values || [];
    cache.set(sheetName, { data, timestamp: Date.now() });
    return data;
  }

  async function getRow(sheetName, rowNumber) {
    const rows = await getAllRowsFromSheet(sheetName);
    return rows[rowNumber - 1] || [];
  }

  async function getLast10Rows(createdBy) {
    const results = await Promise.all(
      lib.ALL_SHEET_NAMES.map(async (sheetName) => ({
        sheetName,
        rows: await getAllRowsFromSheet(sheetName),
      }))
    );

    const found = [];

    for (const item of results) {
      for (let i = 1; i < item.rows.length; i++) {
        const row = item.rows[i];
        if (row[11] !== createdBy) continue;

        const parsedDate = row[12] ? new Date(row[12]) : null;
        const createdAt =
          parsedDate && !isNaN(parsedDate) ? parsedDate : lib.parseDateTime(row[1], row[3]) || new Date(0);

        found.push({ sheetName: item.sheetName, rowNumber: i + 1, row, createdAt });
      }
    }

    return found.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  }

  async function updateCell(sheetName, rowNumber, columnNumber, value) {
    const columnLetter = lib.columnToLetter(columnNumber);

    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!${columnLetter}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] },
      timeout: REQUEST_TIMEOUT,
    });

    cache.delete(sheetName);
  }

  async function deleteRow(sheetName, rowNumber) {
    const sheetId = await getSheetIdByName(sheetName);

    if (sheetId === null) {
      throw new Error(`Sheet tab "${sheetName}" not found — refusing to delete to avoid touching the wrong tab`);
    }

    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber },
            },
          },
        ],
      },
      timeout: REQUEST_TIMEOUT,
    });

    cache.delete(sheetName);
  }

  async function saveRowsToSheet(baseData, equipmentEntries, createdBy) {
    const sheetName = lib.getSheetNameByAircraft(baseData["Aircraft"]);
    const createdAt = new Date().toISOString();

    const rows = equipmentEntries.map((item) => [
      baseData["Flight"] || "",
      baseData["Date"] || "",
      item.equipment || "",
      item.timeIn || "",
      item.timeOut || "",
      lib.calculateUsage(item.timeIn, item.timeOut),
      baseData["Aircraft"] || "",
      baseData["Airport"] || "",
      baseData["Engineer Name"] || "",
      "",
      "",
      createdBy || "",
      createdAt,
    ]);

    await client.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:M`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
      timeout: REQUEST_TIMEOUT,
    });

    cache.delete(sheetName);
  }

  async function moveRow(fromSheetName, rowNumber, toSheetName, rowValues) {
    await client.spreadsheets.values.append({
      spreadsheetId,
      range: `'${toSheetName}'!A:M`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] },
      timeout: REQUEST_TIMEOUT,
    });

    await deleteRow(fromSheetName, rowNumber);

    cache.delete(toSheetName);
  }

  return {
    getSheetIdByName,
    getAllRowsFromSheet,
    getRow,
    getLast10Rows,
    updateCell,
    deleteRow,
    saveRowsToSheet,
    moveRow,
  };
}

module.exports = { createSheetsService, getSheetsClient };
