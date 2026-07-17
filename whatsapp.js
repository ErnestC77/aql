const axios = require("axios");
const lib = require("./lib");

const REQUEST_TIMEOUT = 10000;

// post: injected HTTP post function (axios.post by default, fakeable in tests)
function createWhatsAppClient({ token, phoneNumberId, post = axios.post }) {
  const cleanToken = token.trim();
  const cleanPhoneId = phoneNumberId.trim();
  const url = `https://graph.facebook.com/v19.0/${cleanPhoneId}/messages`;

  function headers() {
    return {
      Authorization: `Bearer ${cleanToken}`,
      "Content-Type": "application/json",
    };
  }

  async function sendMessage(to, text) {
    await post(
      url,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: headers(), timeout: REQUEST_TIMEOUT }
    );
  }

  async function sendButtons(to, body, buttons) {
    await post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            // WhatsApp Cloud API допускает максимум 3 reply-кнопки в одном сообщении
            buttons: buttons.slice(0, 3).map((btn) => ({
              type: "reply",
              reply: { id: btn.id, title: lib.short(btn.title, 20) },
            })),
          },
        },
      },
      { headers: headers(), timeout: REQUEST_TIMEOUT }
    );
  }

  async function sendList(to, body, buttonText, rows) {
    await post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: {
            button: lib.short(buttonText, 20),
            sections: [
              {
                title: "Выбор",
                rows: rows.slice(0, 10).map((row) => ({
                  id: row.id,
                  title: lib.short(row.title, 24),
                  description: lib.short(row.description || "", 72),
                })),
              },
            ],
          },
        },
      },
      { headers: headers(), timeout: REQUEST_TIMEOUT }
    );
  }

  return { sendMessage, sendButtons, sendList };
}

module.exports = { createWhatsAppClient };
