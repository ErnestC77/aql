const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createApp } = require("../index");

function makeDeps(t) {
  return {
    sendMessage: t.mock.fn(async () => {}),
    sendButtons: t.mock.fn(async () => {}),
    sendList: t.mock.fn(async () => {}),
    saveRowsToSheet: t.mock.fn(async () => {}),
    getLast10Rows: t.mock.fn(async () => []),
    updateCell: t.mock.fn(async () => {}),
    deleteRow: t.mock.fn(async () => {}),
    getRow: t.mock.fn(async () => []),
    moveRow: t.mock.fn(async () => {}),
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /health returns 200", async (t) => {
  const { app } = createApp({ env: { VERIFY_TOKEN: "vt" }, deps: makeDeps(t) });

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});

test("GET /webhook echoes the challenge when the verify token matches", async (t) => {
  const { app } = createApp({ env: { VERIFY_TOKEN: "correct-token" }, deps: makeDeps(t) });

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=correct-token&hub.challenge=xyz123`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "xyz123");
  });
});

test("GET /webhook rejects a wrong verify token", async (t) => {
  const { app } = createApp({ env: { VERIFY_TOKEN: "correct-token" }, deps: makeDeps(t) });

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=xyz123`);
    assert.equal(res.status, 403);
  });
});

test("POST /webhook rejects requests with a bad signature when APP_SECRET is configured", async (t) => {
  const deps = makeDeps(t);
  const { app } = createApp({ env: { VERIFY_TOKEN: "vt", APP_SECRET: "app-secret" }, deps });

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef" },
      body: JSON.stringify({ entry: [] }),
    });
    assert.equal(res.status, 403);
    assert.equal(deps.sendMessage.mock.calls.length, 0);
  });
});

test("POST /webhook accepts and processes requests with a valid signature", async (t) => {
  const deps = makeDeps(t);
  const secret = "app-secret";
  const { app } = createApp({ env: { VERIFY_TOKEN: "vt", APP_SECRET: secret }, deps });

  const body = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ id: "m1", from: "79990000000", type: "text", text: { body: "BTN_ADD" } }] } }] }],
  });
  const signature = "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body,
    });
    assert.equal(res.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 20)); // дать асинхронной обработке завершиться
    assert.equal(deps.sendMessage.mock.calls.length, 1);
  });
});

test("POST /webhook still processes when APP_SECRET is not configured (soft-fail, not hard-block)", async (t) => {
  const deps = makeDeps(t);
  const { app } = createApp({ env: { VERIFY_TOKEN: "vt" }, deps });

  const body = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ id: "m1", from: "79990000000", type: "text", text: { body: "BTN_ADD" } }] } }] }],
  });

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
  });
});
