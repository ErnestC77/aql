const lib = require("./lib");

const SESSION_TTL = 60 * 60 * 1000;

// WhatsApp Cloud API допускает максимум 3 reply-кнопки в interactive
// button-сообщении — при 5 пунктах меню нужен список (до 10 строк), иначе
// часть кнопок (тут — "Удалить" и "Справка") молча не доходит до пользователя.
function showMainMenu(deps, to) {
  return deps.sendList(to, "🏠 Главное меню:", "Выбрать", [
    { id: "BTN_ADD", title: "➕ Добавить запись" },
    { id: "BTN_LIST", title: "📋 Мои записи" },
    { id: "BTN_EDIT", title: "✏️ Редактировать" },
    { id: "BTN_DELETE", title: "🗑️ Удалить" },
    { id: "BTN_HELP", title: "❓ Справка" },
  ]);
}

function recordListRows(found, idPrefix) {
  return found.map((item, index) => ({
    id: `${idPrefix}${index}`,
    title: lib.short(`${item.row[0]} ${item.row[1]}`, 24),
    description: lib.short(
      `Борт: ${item.row[6] || ""} | ${item.row[2] || ""} | ${item.row[3] || ""}-${item.row[4] || "не окончено"}`,
      72
    ),
  }));
}

async function goToMainMenu(deps, from, session) {
  session.mode = "menu";
  session.records = null;
  session.editRecord = null;
  session.editField = null;
  session.deleteRecord = null;
  await showMainMenu(deps, from);
}

async function handleMessage(sessions, from, text, deps) {
  if (!sessions[from]) {
    sessions[from] = { mode: "menu", lastActive: Date.now() };
  }

  const session = sessions[from];
  session.lastActive = Date.now();

  if (text === "BTN_ADD") {
    await deps.sendMessage(from, `Введите данные в одну строку в формате:
РЕЙС, ДАТА, САМОЛЕТ, АЭРОПОРТ, ИНЖЕНЕР / ОБОРУДОВАНИЕ, ВРЕМЯ НАЧАЛА, ВРЕМЯ ОКОНЧАНИЯ`);
    session.mode = "menu";
    return;
  }

  if (text === "BTN_LIST" || text.toLowerCase() === "список") {
    const found = await deps.getLast10Rows(from);

    if (found.length === 0) {
      await deps.sendMessage(from, "У вас нет записей.");
      await goToMainMenu(deps, from, session);
      return;
    }

    session.mode = "view_records";
    session.records = found;

    await deps.sendList(from, "Ваши последние 10 записей:", "Выбрать", recordListRows(found, "VIEW_RECORD_"));
    return;
  }

  if (text === "BTN_EDIT" || text.toLowerCase() === "редакт" || text.toLowerCase() === "edit") {
    const found = await deps.getLast10Rows(from);

    if (found.length === 0) {
      await deps.sendMessage(from, "У вас нет записей для редактирования.");
      await goToMainMenu(deps, from, session);
      return;
    }

    session.mode = "edit_choose_record";
    session.records = found;

    await deps.sendList(from, "Выберите запись для редактирования:", "Выбрать", recordListRows(found, "EDIT_RECORD_"));
    return;
  }

  if (session.mode === "edit_choose_record" && text.startsWith("EDIT_RECORD_")) {
    const index = Number(text.replace("EDIT_RECORD_", ""));

    if (isNaN(index) || !session.records || !session.records[index]) {
      await deps.sendMessage(from, "Запись не найдена.");
      await goToMainMenu(deps, from, session);
      return;
    }

    session.editRecord = session.records[index];
    session.mode = "edit_choose_field";

    await deps.sendList(
      from,
      `Что изменить? (Борт: ${session.editRecord.row[6] || ""})`,
      "Выбрать поле",
      lib.editableFields.map((f, i) => ({ id: `EDIT_FIELD_${i}`, title: f.label }))
    );
    return;
  }

  if (session.mode === "edit_choose_field" && text.startsWith("EDIT_FIELD_")) {
    const fieldIndex = Number(text.replace("EDIT_FIELD_", ""));

    if (isNaN(fieldIndex) || !lib.editableFields[fieldIndex]) {
      await deps.sendMessage(from, "Поле не найдено.");
      await goToMainMenu(deps, from, session);
      return;
    }

    session.editField = lib.editableFields[fieldIndex];
    const currentValue = session.editRecord.row?.[session.editField.col - 1] || "не найдено";

    await deps.sendMessage(from, `Текущее значение: ${currentValue}\n\nВведите новое значение для: ${session.editField.label}`);
    session.mode = "edit_enter_value";
    return;
  }

  if (session.mode === "edit_enter_value" && lib.isCommandKeyword(text)) {
    await goToMainMenu(deps, from, session);
    return;
  }

  if (session.mode === "edit_enter_value") {
    const sheetName = session.editRecord.sheetName;
    const rowNumber = session.editRecord.rowNumber;
    const columnNumber = lib.getColumnByField(session.editField.key);

    let valueToSave = text;

    if (session.editField.key === "Aircraft") {
      const normalizedAircraft = text.trim().toUpperCase();
      const targetSheet = lib.getSheetNameByAircraft(normalizedAircraft);

      if (targetSheet !== sheetName) {
        // Каждый борт живёт на своей вкладке — если новый борт относится к
        // другой вкладке, недостаточно поменять ячейку: строка "осиротеет"
        // на старой вкладке. Переносим всю строку на правильную вкладку.
        const updatedRow = session.editRecord.row.slice();
        updatedRow[columnNumber - 1] = normalizedAircraft;

        await deps.moveRow(sheetName, rowNumber, targetSheet, updatedRow);

        session.editRecord.sheetName = targetSheet;
        session.editRecord.row = updatedRow;

        await deps.sendMessage(from, "✅ Запись обновлена и перенесена на вкладку " + targetSheet + ".");
        await goToMainMenu(deps, from, session);
        return;
      }

      valueToSave = normalizedAircraft;
    }

    if (session.editField.key === "Time in" || session.editField.key === "Time out") {
      const normalizedTime = lib.normalizeTimeInput(text);

      if (!normalizedTime) {
        await deps.sendMessage(from, "Неверный формат времени. Введите например 1200, 1330 или 12:00");
        return;
      }

      valueToSave = normalizedTime;
    }

    await deps.updateCell(sheetName, rowNumber, columnNumber, valueToSave);
    session.editRecord.row[columnNumber - 1] = valueToSave;

    if (session.editField.key === "Time in" || session.editField.key === "Time out") {
      // Для ДРУГОГО (не редактируемого сейчас) поля времени берём АКТУАЛЬНОЕ
      // значение прямо из таблицы, а не из session.editRecord.row — тот снапшот
      // мог устареть (например, обновлён ранее в этой же сессии или кем-то ещё).
      const freshRow = await deps.getRow(sheetName, rowNumber);
      const timeIn = session.editField.key === "Time in" ? valueToSave : freshRow[3];
      const timeOut = session.editField.key === "Time out" ? valueToSave : freshRow[4];

      const usage = lib.calculateUsage(timeIn, timeOut);
      await deps.updateCell(sheetName, rowNumber, 6, usage);

      session.editRecord.row[3] = timeIn;
      session.editRecord.row[4] = timeOut;
      session.editRecord.row[5] = usage;
    }

    await deps.sendMessage(from, "✅ Запись обновлена.");
    await goToMainMenu(deps, from, session);
    return;
  }

  if (text === "BTN_DELETE" || text.toLowerCase() === "удалить" || text.toLowerCase() === "delete") {
    const found = await deps.getLast10Rows(from);

    if (found.length === 0) {
      await deps.sendMessage(from, "У вас нет записей для удаления.");
      await goToMainMenu(deps, from, session);
      return;
    }

    session.mode = "delete_choose_record";
    session.records = found;

    await deps.sendList(from, "Выберите запись для удаления:", "Выбрать", recordListRows(found, "DELETE_RECORD_"));
    return;
  }

  if (session.mode === "delete_choose_record" && text.startsWith("DELETE_RECORD_")) {
    const index = Number(text.replace("DELETE_RECORD_", ""));

    if (isNaN(index) || !session.records || !session.records[index]) {
      await deps.sendMessage(from, "Запись не найдена.");
      await goToMainMenu(deps, from, session);
      return;
    }

    session.deleteRecord = session.records[index];
    session.mode = "delete_confirm";

    const row = session.deleteRecord.row;

    await deps.sendButtons(
      from,
      `Удалить эту запись?\nРейс: ${row[0]}\nДата: ${row[1]}\nОборудование: ${row[2]}\nВремя: ${row[3]}-${row[4] || "не окончено"}`,
      [
        { id: "DELETE_YES", title: "Да, удалить" },
        { id: "DELETE_NO", title: "Отмена" },
      ]
    );
    return;
  }

  if (session.mode === "delete_confirm" && text === "DELETE_YES") {
    await deps.deleteRow(session.deleteRecord.sheetName, session.deleteRecord.rowNumber);
    await deps.sendMessage(from, "✅ Запись удалена.");
    await goToMainMenu(deps, from, session);
    return;
  }

  if (session.mode === "delete_confirm" && text === "DELETE_NO") {
    await deps.sendMessage(from, "Удаление отменено.");
    await goToMainMenu(deps, from, session);
    return;
  }

  if (session.mode === "view_records" && text.startsWith("VIEW_RECORD_")) {
    const index = Number(text.replace("VIEW_RECORD_", ""));

    if (isNaN(index) || !session.records || !session.records[index]) {
      await deps.sendMessage(from, "Запись не найдена.");
      await goToMainMenu(deps, from, session);
      return;
    }

    const row = session.records[index].row;

    await deps.sendMessage(
      from,
      `📋 Детали записи:\n\nРейс: ${row[0] || ""}\nДата: ${row[1] || ""}\nОборудование: ${row[2] || ""}\nНачало: ${row[3] || ""}\nОкончание: ${row[4] || ""}\nВремя: ${row[5] || ""}\nБорт: ${row[6] || ""}\nАэропорт: ${row[7] || ""}\nИнженер: ${row[8] || ""}`
    );
    await goToMainMenu(deps, from, session);
    return;
  }

  if (text === "BTN_HELP" || text.toLowerCase() === "помощь" || text.toLowerCase() === "help") {
    await deps.sendMessage(
      from,
      `📖 СПРАВКА\n\nФормат: РЕЙС, ДАТА, САМОЛЁТ, АЭРОПОРТ, ИНЖЕНЕР / ОБОРУДОВАНИЕ, ВРЕМЯ_НАЧАЛА, ВРЕМЯ_ОКОНЧАНИЯ\n\nДопустимые самолёты:\n${lib.aircraftList.join(", ")}\n\nОборудование (примеры, не ограничение):\n${lib.equipmentList.join(", ")}`
    );
    await goToMainMenu(deps, from, session);
    return;
  }

  if (lib.isCommandKeyword(text)) {
    session.mode = "menu";
    await showMainMenu(deps, from);
    return;
  }

  if (text === "") {
    await deps.sendMessage(from, "Такой тип сообщения не поддерживается. Отправьте текст или используйте /меню.");
    return;
  }

  const parsed = lib.parseInputLine(text);

  if (!parsed.ok) {
    await deps.sendMessage(
      from,
      parsed.reason || "❌ Ошибка в формате ввода. Напишите 'помощь' для справки."
    );
    return;
  }

  await deps.saveRowsToSheet(parsed.baseData, parsed.equipmentEntries, from);

  const preview = `✅ Данные успешно сохранены!\n\nРейс: ${parsed.baseData.Flight}\nСамолёт: ${parsed.baseData.Aircraft}\nВкладка: ${lib.getSheetNameByAircraft(parsed.baseData.Aircraft)}\n\nОборудование (${parsed.equipmentEntries.length}):\n${parsed.equipmentEntries.map((item, i) => `${i + 1}. ${item.equipment}: ${item.timeIn}-${item.timeOut || "не окончено"}`).join("\n")}`;

  await deps.sendMessage(from, preview);
  await goToMainMenu(deps, from, session);
}

module.exports = { handleMessage, showMainMenu, SESSION_TTL };
