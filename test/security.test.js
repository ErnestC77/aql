const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateRequiredEnv, verifySignature, REQUIRED_ENV_VARS } = require("../security");

test("validateRequiredEnv reports missing required keys", () => {
  const missing = validateRequiredEnv({ WHATSAPP_TOKEN: "x" });
  assert.ok(missing.includes("GOOGLE_PRIVATE_KEY"));
  assert.ok(!missing.includes("WHATSAPP_TOKEN"));
});

test("validateRequiredEnv returns empty array when everything is present", () => {
  const fullEnv = {};
  for (const key of REQUIRED_ENV_VARS) fullEnv[key] = "value";
  assert.deepEqual(validateRequiredEnv(fullEnv), []);
});

test("verifySignature accepts a correctly-signed body", () => {
  const secret = "app-secret";
  const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
  const signature = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  assert.equal(verifySignature(secret, rawBody, signature), true);
});

test("verifySignature rejects a forged/mismatched signature", () => {
  const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(verifySignature("app-secret", rawBody, "sha256=deadbeef"), false);
});

test("verifySignature rejects a missing signature header", () => {
  const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(verifySignature("app-secret", rawBody, undefined), false);
});
