const crypto = require("node:crypto");

const REQUIRED_ENV_VARS = [
  "WHATSAPP_TOKEN",
  "PHONE_NUMBER_ID",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_SHEET_ID",
  "VERIFY_TOKEN",
];

function validateRequiredEnv(env) {
  return REQUIRED_ENV_VARS.filter((key) => !env[key]);
}

// Проверка X-Hub-Signature-256 по спецификации Meta: HMAC-SHA256(appSecret, rawBody).
function verifySignature(appSecret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");

  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = { REQUIRED_ENV_VARS, validateRequiredEnv, verifySignature };
