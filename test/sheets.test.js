const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSheetsService } = require("../sheets");

// Имитирует реальное поведение googleapis/Google API: любой лишний ключ в
// params (первый аргумент) — это уже часть тела/query запроса к Google, и
// сервер отвечает 400 "Unknown name ... Cannot bind query parameter."
// Настройки транспорта (timeout и т.п.) должны идти ВТОРЫМ аргументом.
const KNOWN_PARAM_KEYS = new Set([
  "spreadsheetId",
  "range",
  "valueInputOption",
  "requestBody",
]);

function assertCleanParams(params) {
  for (const key of Object.keys(params)) {
    if (!KNOWN_PARAM_KEYS.has(key)) {
      const err = new Error(`Invalid JSON payload received. Unknown name "${key}": Cannot bind query parameter.`);
      err.code = 400;
      throw err;
    }
  }
}

function fakeClient({ sheetsMeta = [{ properties: { title: "B747F", sheetId: 111 } }] } = {}) {
  return {
    spreadsheets: {
      get: async (params, options) => {
        assertCleanParams(params);
        return { data: { sheets: sheetsMeta } };
      },
      batchUpdate: async (params, options) => {
        assertCleanParams(params);
        return {};
      },
      values: {
        get: async (params, options) => {
          assertCleanParams(params);
          return { data: { values: [] } };
        },
        update: async (params, options) => {
          assertCleanParams(params);
          return {};
        },
        append: async (params, options) => {
          assertCleanParams(params);
          return {};
        },
      },
    },
  };
}

test("getSheetIdByName returns the real sheetId when found", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  const id = await svc.getSheetIdByName("B747F");
  assert.equal(id, 111);
});

test("getSheetIdByName returns null (not 0) when the tab is not found", async () => {
  const svc = createSheetsService(fakeClient({ sheetsMeta: [] }), "spreadsheet-id");
  const id = await svc.getSheetIdByName("MISSING");
  assert.equal(id, null);
});

test("deleteRow refuses to proceed when the sheet tab can't be resolved, instead of defaulting to sheetId 0", async () => {
  const client = fakeClient({ sheetsMeta: [] });
  let batchUpdateCalled = false;
  client.spreadsheets.batchUpdate = async (params) => {
    assertCleanParams(params);
    batchUpdateCalled = true;
    return {};
  };

  const svc = createSheetsService(client, "spreadsheet-id");

  await assert.rejects(() => svc.deleteRow("MISSING", 5));
  assert.equal(batchUpdateCalled, false);
});

test("getSheetIdByName does not send timeout as a Google API request param", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  await svc.getSheetIdByName("B747F"); // throws (via assertCleanParams) if timeout leaks into params
});

test("getAllRowsFromSheet does not send timeout as a Google API request param", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  await svc.getAllRowsFromSheet("B747F");
});

test("updateCell does not send timeout as a Google API request param", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  await svc.updateCell("B747F", 5, 1, "TVR4702");
});

test("saveRowsToSheet does not send timeout as a Google API request param", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  await svc.saveRowsToSheet({ Aircraft: "ER-BAS" }, [{ equipment: "GPU", timeIn: "10:00", timeOut: "" }], "79990000000");
});

test("deleteRow does not send timeout as a Google API request param", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  await svc.deleteRow("B747F", 5);
});

test("moveRow does not send timeout as a Google API request param", async () => {
  const svc = createSheetsService(fakeClient(), "spreadsheet-id");
  await svc.moveRow("B747F", 5, "B747F", ["TVR4701"]);
});
