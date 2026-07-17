const { test } = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../lib");

test("normalizeTimeInput accepts HH:MM", () => {
  assert.equal(lib.normalizeTimeInput("9:5"), null);
  assert.equal(lib.normalizeTimeInput("09:05"), "09:05");
});

test("normalizeTimeInput accepts run-together digits", () => {
  assert.equal(lib.normalizeTimeInput("1200"), "12:00");
  assert.equal(lib.normalizeTimeInput("905"), "09:05");
});

test("normalizeTimeInput rejects out-of-range", () => {
  assert.equal(lib.normalizeTimeInput("2500"), null);
  assert.equal(lib.normalizeTimeInput("1261"), null);
});

test("calculateUsage computes simple duration", () => {
  assert.equal(lib.calculateUsage("10:00", "12:30"), "2:30");
});

test("calculateUsage wraps past midnight", () => {
  assert.equal(lib.calculateUsage("23:00", "01:00"), "2:00");
});

test("getSheetNameByAircraft maps known tail, falls back for unknown", () => {
  assert.equal(lib.getSheetNameByAircraft("ER-BAS"), "B747F");
  assert.equal(lib.getSheetNameByAircraft("UNKNOWN"), "Sheet1");
});

test("extractIncomingText handles text and button/list replies", () => {
  assert.equal(lib.extractIncomingText({ type: "text", text: { body: " hi " } }), "hi");
  assert.equal(
    lib.extractIncomingText({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "BTN_ADD" } } }),
    "BTN_ADD"
  );
  assert.equal(
    lib.extractIncomingText({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "EDIT_RECORD_0" } } }),
    "EDIT_RECORD_0"
  );
  assert.equal(lib.extractIncomingText({ type: "image" }), "");
});

test("isCommandKeyword is case-insensitive", () => {
  assert.equal(lib.isCommandKeyword("МЕНЮ"), true);
  assert.equal(lib.isCommandKeyword("hello"), false);
});
