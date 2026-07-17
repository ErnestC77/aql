const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWhatsAppClient } = require("../whatsapp");

function fakePost(t) {
  return t.mock.fn(async () => ({ data: {} }));
}

test("sendMessage posts a plain text payload to the right phone number id", async (t) => {
  const post = fakePost(t);
  const wa = createWhatsAppClient({ token: "tok", phoneNumberId: "123", post });

  await wa.sendMessage("79990000000", "hello");

  assert.equal(post.mock.calls.length, 1);
  const [url, body] = post.mock.calls[0].arguments;
  assert.match(url, /123\/messages$/);
  assert.equal(body.to, "79990000000");
  assert.equal(body.text.body, "hello");
});

test("sendButtons truncates to WhatsApp's 3-button hard limit as a safety guard", async (t) => {
  const post = fakePost(t);
  const wa = createWhatsAppClient({ token: "tok", phoneNumberId: "123", post });

  await wa.sendButtons("79990000000", "pick one", [
    { id: "A", title: "A" },
    { id: "B", title: "B" },
    { id: "C", title: "C" },
    { id: "D", title: "D" },
  ]);

  const [, body] = post.mock.calls[0].arguments;
  assert.equal(body.interactive.action.buttons.length, 3);
});

test("sendList sends up to 10 rows", async (t) => {
  const post = fakePost(t);
  const wa = createWhatsAppClient({ token: "tok", phoneNumberId: "123", post });

  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `R${i}`, title: `Row ${i}` }));
  await wa.sendList("79990000000", "body", "Выбрать", rows);

  const [, body] = post.mock.calls[0].arguments;
  assert.equal(body.interactive.action.sections[0].rows.length, 5);
});
