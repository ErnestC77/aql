const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWebhookProcessor } = require("../webhook");

function makeDeps(t, onSendMessage) {
  return {
    sendMessage: t.mock.fn(async (to, text) => {
      if (onSendMessage) await onSendMessage(to, text);
    }),
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

function textMessage(id, from, body) {
  return { id, from, type: "text", text: { body } };
}

function payload(messages) {
  return { entry: [{ changes: [{ value: { messages } }] }] };
}

test("processes every message in a batched webhook delivery, not just the first", async (t) => {
  const deps = makeDeps(t);
  const proc = createWebhookProcessor({ deps });

  await proc.handleWebhookBody(
    payload([textMessage("m1", "79990000000", "BTN_ADD"), textMessage("m2", "79991111111", "BTN_ADD")])
  );

  assert.equal(deps.sendMessage.mock.calls.length, 2);
});

test("deduplicates retried webhook deliveries by message.id (no double-save)", async (t) => {
  const deps = makeDeps(t);
  const proc = createWebhookProcessor({ deps });

  const body = payload([textMessage("dup-1", "79990000000", "TVR4701, 01.05.2026, ER-BAS, HKG, Ernest / GPU, 1000")]);

  await proc.handleWebhookBody(body);
  await proc.handleWebhookBody(body); // Meta retry with the same message.id

  assert.equal(deps.saveRowsToSheet.mock.calls.length, 1);
});

test("serializes concurrent messages from the SAME user (no interleaving)", async (t) => {
  const order = [];
  const deps = makeDeps(t, async (to, text) => {
    order.push(`start:${text}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(`end:${text}`);
  });
  const proc = createWebhookProcessor({ deps });

  const p1 = proc.handleWebhookBody(payload([textMessage("a", "79990000000", "BTN_ADD")]));
  const p2 = proc.handleWebhookBody(payload([textMessage("b", "79990000000", "BTN_ADD")]));

  await Promise.all([p1, p2]);

  // Без сериализации порядок был бы start,start,end,end (переплетение).
  // С сериализацией — строго start,end,start,end для одного пользователя.
  assert.equal(order.length, 4);
  assert.ok(order[0].startsWith("start:"));
  assert.ok(order[1].startsWith("end:"));
  assert.ok(order[2].startsWith("start:"));
  assert.ok(order[3].startsWith("end:"));
});

test("different users are NOT serialized against each other", async (t) => {
  const order = [];
  const deps = makeDeps(t, async (to, text) => {
    order.push(`start:${to}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(`end:${to}`);
  });
  const proc = createWebhookProcessor({ deps });

  const p1 = proc.handleWebhookBody(payload([textMessage("a", "79990000000", "BTN_ADD")]));
  const p2 = proc.handleWebhookBody(payload([textMessage("b", "79991111111", "BTN_ADD")]));

  await Promise.all([p1, p2]);

  // Разные пользователи должны выполняться конкурентно: оба start раньше обоих end.
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(["start:79990000000", "start:79991111111"]));
});
