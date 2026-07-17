const { test } = require("node:test");
const assert = require("node:assert/strict");
const { handleMessage } = require("../core");

function makeDeps(t) {
  return {
    sendMessage: t.mock.fn(async () => {}),
    sendButtons: t.mock.fn(async () => {}),
    sendList: t.mock.fn(async () => {}),
    saveRowsToSheet: t.mock.fn(async () => {}),
    getLast10Rows: t.mock.fn(async () => []),
    updateCell: t.mock.fn(async () => {}),
    deleteRow: t.mock.fn(async () => {}),
    getSheetIdByName: t.mock.fn(async () => 111),
    getRow: t.mock.fn(async () => []),
    moveRow: t.mock.fn(async () => {}),
  };
}

test("BTN_ADD works on the very first message from a brand-new session (no swallow)", async (t) => {
  const sessions = {};
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "BTN_ADD", deps);

  assert.equal(deps.sendMessage.mock.calls.length, 1);
  assert.match(deps.sendMessage.mock.calls[0].arguments[1], /Введите данные/);
});

test("main menu shows all 5 options via a list (WhatsApp buttons cap at 3)", async (t) => {
  const sessions = { "79990000000": { mode: "menu", lastActive: Date.now() } };
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "меню", deps);

  assert.equal(deps.sendButtons.mock.calls.length, 0);
  assert.equal(deps.sendList.mock.calls.length, 1);

  const rows = deps.sendList.mock.calls[0].arguments[3];
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, ["BTN_ADD", "BTN_LIST", "BTN_EDIT", "BTN_DELETE", "BTN_HELP"]);
});

test("BTN_LIST shows the user's records and switches mode to view_records", async (t) => {
  const sessions = { "79990000000": { mode: "menu", lastActive: Date.now() } };
  const deps = makeDeps(t);
  deps.getLast10Rows = t.mock.fn(async () => [
    { sheetName: "B747F", rowNumber: 5, row: ["TVR4701", "01.05.2026", "GPU", "10:00", "12:00"] },
  ]);

  await handleMessage(sessions, "79990000000", "BTN_LIST", deps);

  assert.equal(deps.sendList.mock.calls.length, 1);
  assert.equal(sessions["79990000000"].mode, "view_records");
  assert.equal(sessions["79990000000"].records.length, 1);
});

test("BTN_EDIT -> select record -> select field -> enter value updates the cell", async (t) => {
  const sessions = { "79990000000": { mode: "menu", lastActive: Date.now() } };
  const deps = makeDeps(t);
  deps.getLast10Rows = t.mock.fn(async () => [
    { sheetName: "B747F", rowNumber: 5, row: ["TVR4701", "01.05.2026", "GPU", "10:00", "12:00", "2:00", "ER-BAS"] },
  ]);

  await handleMessage(sessions, "79990000000", "BTN_EDIT", deps);
  assert.equal(sessions["79990000000"].mode, "edit_choose_record");

  await handleMessage(sessions, "79990000000", "EDIT_RECORD_0", deps);
  assert.equal(sessions["79990000000"].mode, "edit_choose_field");

  await handleMessage(sessions, "79990000000", "EDIT_FIELD_0", deps); // Flight
  assert.equal(sessions["79990000000"].mode, "edit_enter_value");

  await handleMessage(sessions, "79990000000", "TVR4702", deps);

  assert.equal(deps.updateCell.mock.calls.length, 1);
  assert.deepEqual(deps.updateCell.mock.calls[0].arguments, ["B747F", 5, 1, "TVR4702"]);
  assert.equal(sessions["79990000000"].mode, "menu");
});

test("typing 'меню' while entering an edit value escapes instead of being saved as the value", async (t) => {
  const sessions = {
    "79990000000": {
      mode: "edit_enter_value",
      editRecord: { sheetName: "B747F", rowNumber: 5, row: ["TVR4701", "01.05.2026", "GPU", "10:00", "12:00", "2:00", "ER-BAS"] },
      editField: { key: "Flight", label: "Номер рейса", col: 1 },
      lastActive: Date.now(),
    },
  };
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "меню", deps);

  assert.equal(deps.updateCell.mock.calls.length, 0);
  assert.equal(sessions["79990000000"].mode, "menu");
  assert.equal(sessions["79990000000"].editField, null);
});

test("usage recalculation uses a FRESH row fetch for the other time field, not a stale session snapshot", async (t) => {
  // session.editRecord.row был захвачен, когда показывался список записей, и
  // содержит устаревшее Time in "09:00". С тех пор Time in реально уже стало
  // "10:00" (например, сохранено предыдущим шагом этой же сессии). Пересчёт
  // длительности при сохранении Time out обязан подтянуть АКТУАЛЬНОЕ Time in
  // из таблицы (deps.getRow), а не доверять устаревшему session-снапшоту.
  const sessions = {
    "79990000000": {
      mode: "edit_enter_value",
      editRecord: { sheetName: "B747F", rowNumber: 5, row: ["TVR4701", "01.05.2026", "GPU", "09:00", "10:00", "1:00", "ER-BAS"] },
      editField: { key: "Time out", label: "Время окончания", col: 5 },
      lastActive: Date.now(),
    },
  };
  const deps = makeDeps(t);
  deps.getRow = t.mock.fn(async () => ["TVR4701", "01.05.2026", "GPU", "10:00", "10:00", "1:00", "ER-BAS"]);

  await handleMessage(sessions, "79990000000", "1200", deps);

  const usageCalls = deps.updateCell.mock.calls.filter((c) => c.arguments[2] === 6);
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0].arguments[3], "2:00"); // 10:00 (fresh) -12:00, not 09:00 (stale) -12:00
});

test("BTN_DELETE -> select record -> confirm deletes the row", async (t) => {
  const sessions = { "79990000000": { mode: "menu", lastActive: Date.now() } };
  const deps = makeDeps(t);
  deps.getLast10Rows = t.mock.fn(async () => [
    { sheetName: "B747F", rowNumber: 5, row: ["TVR4701", "01.05.2026", "GPU", "10:00", "12:00"] },
  ]);

  await handleMessage(sessions, "79990000000", "BTN_DELETE", deps);
  await handleMessage(sessions, "79990000000", "DELETE_RECORD_0", deps);
  assert.equal(sessions["79990000000"].mode, "delete_confirm");

  await handleMessage(sessions, "79990000000", "DELETE_YES", deps);

  assert.equal(deps.deleteRow.mock.calls.length, 1);
  assert.deepEqual(deps.deleteRow.mock.calls[0].arguments, ["B747F", 5]);
  assert.equal(sessions["79990000000"].mode, "menu");
});

test("DELETE_NO cancels without deleting", async (t) => {
  const sessions = {
    "79990000000": {
      mode: "delete_confirm",
      deleteRecord: { sheetName: "B747F", rowNumber: 5, row: ["TVR4701"] },
      lastActive: Date.now(),
    },
  };
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "DELETE_NO", deps);

  assert.equal(deps.deleteRow.mock.calls.length, 0);
  assert.equal(sessions["79990000000"].mode, "menu");
});

test("valid freeform record is saved and confirmed", async (t) => {
  const sessions = { "79990000000": { mode: "menu", lastActive: Date.now() } };
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "TVR4701, 01.05.2026, ER-BAS, HKG, Ernest / GPU, 1000, 1230", deps);

  assert.equal(deps.saveRowsToSheet.mock.calls.length, 1);
  const [baseData, equipmentEntries] = deps.saveRowsToSheet.mock.calls[0].arguments;
  assert.equal(baseData.Flight, "TVR4701");
  assert.deepEqual(equipmentEntries, [{ equipment: "GPU", timeIn: "10:00", timeOut: "12:30" }]);
});

test("invalid freeform input surfaces the specific parse-error reason to the user", async (t) => {
  const sessions = { "79990000000": { mode: "menu", lastActive: Date.now() } };
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "TVR4701, 01.05.2026, ZZ-ZZZ, HKG, Ernest / GPU, 1000", deps);

  assert.equal(deps.saveRowsToSheet.mock.calls.length, 0);
  assert.equal(deps.sendMessage.mock.calls.length, 1);
  assert.match(deps.sendMessage.mock.calls[0].arguments[1], /ZZ-ZZZ/);
});

test("empty text (non-text message like an image) gets a helpful reply, not silence", async (t) => {
  const sessions = {};
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "", deps);

  assert.equal(deps.sendMessage.mock.calls.length, 1);
});

test("editing Aircraft to a tail on a different tab moves the whole row, not just the cell", async (t) => {
  const sessions = {
    "79990000000": {
      mode: "edit_enter_value",
      editRecord: {
        sheetName: "B747F", // ER-BAS/ER-BYK tab
        rowNumber: 5,
        row: ["TVR4701", "01.05.2026", "GPU", "10:00", "12:00", "2:00", "ER-BAS", "HKG", "Ernest"],
      },
      editField: { key: "Aircraft", label: "Самолёт", col: 7 },
      lastActive: Date.now(),
    },
  };
  const deps = makeDeps(t);
  deps.moveRow = t.mock.fn(async () => {});

  // ER-UFC живёт на вкладке B733F — другой борт, другая вкладка
  await handleMessage(sessions, "79990000000", "ER-UFC", deps);

  assert.equal(deps.updateCell.mock.calls.length, 0);
  assert.equal(deps.moveRow.mock.calls.length, 1);

  const [fromSheet, rowNumber, toSheet, rowValues] = deps.moveRow.mock.calls[0].arguments;
  assert.equal(fromSheet, "B747F");
  assert.equal(rowNumber, 5);
  assert.equal(toSheet, "B733F");
  assert.equal(rowValues[6], "ER-UFC");

  assert.equal(sessions["79990000000"].mode, "menu");
});

test("editing Aircraft to a tail on the SAME tab just updates the cell (no move)", async (t) => {
  const sessions = {
    "79990000000": {
      mode: "edit_enter_value",
      editRecord: {
        sheetName: "B747F",
        rowNumber: 5,
        row: ["TVR4701", "01.05.2026", "GPU", "10:00", "12:00", "2:00", "ER-BAS", "HKG", "Ernest"],
      },
      editField: { key: "Aircraft", label: "Самолёт", col: 7 },
      lastActive: Date.now(),
    },
  };
  const deps = makeDeps(t);
  deps.moveRow = t.mock.fn(async () => {});

  // ER-BYK тоже на B747F — тот же таб, переезд не нужен
  await handleMessage(sessions, "79990000000", "ER-BYK", deps);

  assert.equal(deps.moveRow.mock.calls.length, 0);
  assert.equal(deps.updateCell.mock.calls.length, 1);
});

test("'отмена' also escapes edit_enter_value (explicit cancel word)", async (t) => {
  const sessions = {
    "79990000000": {
      mode: "edit_enter_value",
      editRecord: { sheetName: "B747F", rowNumber: 5, row: ["TVR4701"] },
      editField: { key: "Flight", label: "Номер рейса", col: 1 },
      lastActive: Date.now(),
    },
  };
  const deps = makeDeps(t);

  await handleMessage(sessions, "79990000000", "отмена", deps);

  assert.equal(deps.updateCell.mock.calls.length, 0);
  assert.equal(sessions["79990000000"].mode, "menu");
});
