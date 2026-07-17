const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSheetsService } = require("../sheets");

function fakeClient({ sheetsMeta = [{ properties: { title: "B747F", sheetId: 111 } }] } = {}) {
  return {
    spreadsheets: {
      get: async () => ({ data: { sheets: sheetsMeta } }),
      batchUpdate: async () => ({}),
      values: {
        get: async () => ({ data: { values: [] } }),
        update: async () => ({}),
        append: async () => ({}),
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
  client.spreadsheets.batchUpdate = async () => {
    batchUpdateCalled = true;
    return {};
  };

  const svc = createSheetsService(client, "spreadsheet-id");

  await assert.rejects(() => svc.deleteRow("MISSING", 5));
  assert.equal(batchUpdateCalled, false);
});
