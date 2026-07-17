const lib = require("./lib");
const { handleMessage } = require("./core");

function createWebhookProcessor({ sessions = {}, deps, maxSeenIds = 500 }) {
  const seenIds = [];
  const seenSet = new Set();
  const locks = new Map(); // phone -> tail of the promise chain for that user

  function alreadySeen(id) {
    // Без message.id дедупликация невозможна — пропускаем как новое.
    if (!id) return false;

    if (seenSet.has(id)) return true;

    seenSet.add(id);
    seenIds.push(id);

    if (seenIds.length > maxSeenIds) {
      const oldest = seenIds.shift();
      seenSet.delete(oldest);
    }

    return false;
  }

  // Сообщения одного пользователя должны обрабатываться строго по очереди
  // (иначе один быстрый второй запрос может перезаписать session.mode/records
  // посреди обработки первого). Разные пользователи выполняются конкурентно.
  function runLocked(from, task) {
    const previous = locks.get(from) || Promise.resolve();
    const result = previous.then(task, task);
    locks.set(
      from,
      result.catch(() => {})
    );
    return result;
  }

  async function handleWebhookBody(body) {
    const entries = body.entry || [];
    const tasks = [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) {
          if (alreadySeen(message.id)) continue;

          const from = message.from;
          const text = lib.extractIncomingText(message);

          tasks.push(runLocked(from, () => handleMessage(sessions, from, text, deps)));
        }
      }
    }

    await Promise.all(tasks);
  }

  return { handleWebhookBody, sessions };
}

module.exports = { createWebhookProcessor };
