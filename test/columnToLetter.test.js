const { test } = require("node:test");
const assert = require("node:assert/strict");
const { columnToLetter } = require("../lib");

test("columnToLetter converts 1-26 to single letters", () => {
  assert.equal(columnToLetter(1), "A");
  assert.equal(columnToLetter(9), "I");
  assert.equal(columnToLetter(26), "Z");
});

test("columnToLetter converts columns beyond 26 to double letters", () => {
  assert.equal(columnToLetter(27), "AA");
  assert.equal(columnToLetter(52), "AZ");
});
