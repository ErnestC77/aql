const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseInputLine } = require("../lib");

test("parses a valid single-equipment line with end time", () => {
  const result = parseInputLine(
    "TVR4701, 01.05.2026, ER-BAS, HKG, Ernest / GPU, 1000, 1230"
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.baseData, {
    Flight: "TVR4701",
    Date: "01.05.2026",
    Aircraft: "ER-BAS",
    Airport: "HKG",
    "Engineer Name": "Ernest",
  });
  assert.deepEqual(result.equipmentEntries, [
    { equipment: "GPU", timeIn: "10:00", timeOut: "12:30" },
  ]);
});

test("date typed with slashes (dd/mm/yyyy) does not break group splitting", () => {
  const result = parseInputLine(
    "TVR4701, 01/05/2026, ER-BAS, HKG, Ernest / GPU, 1000"
  );

  assert.equal(result.ok, true);
  assert.equal(result.baseData.Date, "01.05.2026");
  assert.deepEqual(result.equipmentEntries, [
    { equipment: "GPU", timeIn: "10:00", timeOut: "" },
  ]);
});

test("aircraft tail typed with Cyrillic look-alike letters is normalized", () => {
  // Кириллические В (U+0412) и А (U+0410) вместо латинских B/A — легко набрать
  // случайно с русской раскладкой клавиатуры.
  const result = parseInputLine(
    "TVR4701, 01.05.2026, ER-ВАS, HKG, Ernest / GPU, 1000"
  );

  assert.equal(result.ok, true);
  assert.equal(result.baseData.Aircraft, "ER-BAS");
});

test("airport code with Cyrillic look-alike letters is normalized too", () => {
  // Кириллическая Н (U+041D) визуально неотличима от латинской H.
  const result = parseInputLine(
    "TVR4701, 01.05.2026, ER-BAS, НKG, Ernest / GPU, 1000"
  );

  assert.equal(result.ok, true);
  assert.equal(result.baseData.Airport, "HKG");
});

test("malformed equipment group is reported, not silently dropped", () => {
  // "GPU 1000" (пробел вместо запятой) раньше молча выпадал из записи,
  // сохранялась только вторая группа — пользователь не узнавал о потере.
  const result = parseInputLine(
    "TVR4701, 01.05.2026, ER-BAS, HKG, Ernest / GPU 1000 / PAXSTEP, 1100"
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /GPU 1000/);
});

test("unknown aircraft tail gets a specific reason listing valid tails", () => {
  const result = parseInputLine(
    "TVR4701, 01.05.2026, ZZ-ZZZ, HKG, Ernest / GPU, 1000"
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /ZZ-ZZZ/);
  assert.match(result.reason, /ER-BAS/);
});

test("invalid date gets a specific reason", () => {
  const result = parseInputLine(
    "TVR4701, 99.99.9999, ER-BAS, HKG, Ernest / GPU, 1000"
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /дат/i);
});

test("valid date dd.mm.yyyy still parses fine", () => {
  const result = parseInputLine(
    "TVR4701, 31.12.2026, ER-BAS, HKG, Ernest / GPU, 1000"
  );

  assert.equal(result.ok, true);
});

test("invalid time in an equipment group gets a specific reason", () => {
  const result = parseInputLine(
    "TVR4701, 01.05.2026, ER-BAS, HKG, Ernest / GPU, 12.00"
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /GPU/);
  assert.match(result.reason, /12\.00/);
});

test("too few base fields gets a specific reason", () => {
  const result = parseInputLine("TVR4701, 01.05.2026, ER-BAS / GPU, 1000");

  assert.equal(result.ok, false);
  assert.match(result.reason, /рейс/i);
});

test("missing slash separator gets a specific reason", () => {
  const result = parseInputLine("TVR4701, 01.05.2026, ER-BAS, HKG, Ernest");

  assert.equal(result.ok, false);
  assert.match(result.reason, /\//);
});
