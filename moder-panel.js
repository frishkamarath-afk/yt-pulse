(() => {
  const MOD_API_ENDPOINT = (window.YT_VALHALLA_MOD_SERVICE?.endpoint || "").replace(/\/+$/, "");
  const TELEGRAM_ROLE = "moderator";
  const TELEGRAM_SESSION_KEY = "ytValhallaTelegramModeratorSession";

  const telegramState = {
    requestId: "",
    sessionToken: sessionStorage.getItem(TELEGRAM_SESSION_KEY) || "",
    busy: false,
  };

  const modService = {
    endpoint: MOD_API_ENDPOINT,
    adminKey: "",
    connected: false,
    busy: false,
  };

  const elements = {
    root: document.querySelector("#moder-panel"),
    protectedPanel: document.querySelector("#moder-protected"),
    telegramAuthCard: document.querySelector("#moder-telegram-auth-card"),
    telegramSendCode: document.querySelector("#moder-telegram-send-code"),
    telegramCodeForm: document.querySelector("#moder-telegram-code-form"),
    telegramCodeInput: document.querySelector("#moder-telegram-code"),
    telegramVerifyCode: document.querySelector("#moder-telegram-verify-code"),
    telegramStatus: document.querySelector("#moder-telegram-auth-status"),
    authCard: document.querySelector("#mod-auth-card"),
    authForm: document.querySelector("#mod-auth-form"),
    keyInput: document.querySelector("#mod-admin-key"),
    rememberKey: document.querySelector("#remember-mod-key"),
    controlCard: document.querySelector("#mod-control-card"),
    logoutButton: document.querySelector("#mod-logout-button"),
    toggle: document.querySelector("#mod-enabled-toggle"),
    toggleLabel: document.querySelector("#mod-toggle-label"),
    emergencyLock: document.querySelector("#mod-emergency-lock"),
    badge: document.querySelector("#mod-status-badge"),
    title: document.querySelector("#mod-status-title"),
    description: document.querySelector("#mod-status-description"),
    messageInput: document.querySelector("#mod-disabled-message"),
    saveMessage: document.querySelector("#save-mod-message"),
    refreshLogs: document.querySelector("#refresh-mod-logs"),
    clearLogs: document.querySelector("#clear-mod-logs"),
    sessionsBody: document.querySelector("#mod-sessions-body"),
    sessionsEmpty: document.querySelector("#mod-sessions-empty"),
    logsBody: document.querySelector("#mod-logs-body"),
    logsEmpty: document.querySelector("#mod-logs-empty"),
    toast: document.querySelector("#toast"),
  };

  if (!elements.root || !elements.telegramAuthCard || !elements.authForm) {
    return;
  }

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message, error = false) {
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", error);
    elements.toast.classList.add("visible");
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => elements.toast.classList.remove("visible"), 3200);
  }

  function setTelegramStatus(message, type = "") {
    elements.telegramStatus.textContent = message;
    elements.telegramStatus.classList.toggle("error", type === "error");
    elements.telegramStatus.classList.toggle("success", type === "success");
  }

  function networkError(cause) {
    const error = new Error(
      `Не удалось подключиться к VDS API. Откройте ${MOD_API_ENDPOINT}/health на этом компьютере: если страница не открывается, сеть или браузер блокирует домен API.`,
    );
    error.code = "NETWORK_ERROR";
    error.cause = cause;
    return error;
  }

  function formatMemory(value) {
    return `${Number(value || 0).toLocaleString("ru-RU")} МБ`;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("ru-RU");
  }

  async function telegramApi(path, options = {}) {
    if (!MOD_API_ENDPOINT) {
      throw new Error("VDS API не настроен");
    }

    let response;
    try {
      response = await fetch(`${MOD_API_ENDPOINT}${path}`, {
        method: options.method || "GET",
        cache: "no-store",
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(telegramState.sessionToken ? { "X-Telegram-Session": telegramState.sessionToken } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      throw networkError(error);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok || !result?.ok) {
      const error = new Error(result?.error || `Telegram auth: ${response.status}`);
      error.code = result?.code;
      error.status = response.status;
      throw error;
    }

    return result;
  }

  async function modRequest(path, options = {}) {
    if (!modService.endpoint) {
      throw new Error("Сервис управления ещё не настроен");
    }

    let response;
    try {
      response = await fetch(`${modService.endpoint}${path}`, {
        method: options.method || "GET",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${modService.adminKey}`,
          ...(telegramState.sessionToken ? { "X-Telegram-Session": telegramState.sessionToken } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      throw networkError(error);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok || !result?.ok) {
      const error = new Error(result?.error || `VDS API: ${response.status}`);
      error.code = result?.code;
      error.status = response.status;
      throw error;
    }

    return result;
  }

  function handleTelegramRequired(error) {
    if (error.code !== "TELEGRAM_REQUIRED") return false;
    telegramState.sessionToken = "";
    sessionStorage.removeItem(TELEGRAM_SESSION_KEY);
    window.YT_VALHALLA_TELEGRAM_SESSION = "";
    elements.protectedPanel.hidden = true;
    elements.telegramAuthCard.hidden = false;
    setTelegramStatus("Сессия Telegram истекла. Запросите новый код.", "error");
    return true;
  }

  async function requestTelegramCode() {
    if (telegramState.busy) return;
    telegramState.busy = true;
    elements.telegramSendCode.disabled = true;
    setTelegramStatus("Отправляем код через Telegram…");

    try {
      const result = await telegramApi("/api/v1/admin/telegram/request", {
        method: "POST",
        body: { role: TELEGRAM_ROLE },
      });
      telegramState.requestId = result.requestId;
      elements.telegramCodeInput.disabled = false;
      elements.telegramVerifyCode.disabled = false;
      elements.telegramCodeInput.value = "";
      elements.telegramCodeInput.focus();
      setTelegramStatus("Код отправлен в Telegram. Введите 6 цифр из сообщения бота.", "success");
    } catch (error) {
      const message =
        error.code === "TELEGRAM_SETUP_REQUIRED"
          ? "Откройте Telegram-бота, нажмите Start или отправьте /start, затем нажмите кнопку ещё раз."
          : error.code === "TELEGRAM_CHAT_AMBIGUOUS"
            ? "Боту написали несколько чатов. Нужно закрепить ваш chat_id на сервере."
            : error.message;
      setTelegramStatus(message, "error");
    } finally {
      telegramState.busy = false;
      elements.telegramSendCode.disabled = false;
    }
  }

  async function verifyTelegramCode(code) {
    if (telegramState.busy || !telegramState.requestId) return;
    telegramState.busy = true;
    elements.telegramVerifyCode.disabled = true;
    setTelegramStatus("Проверяем код…");

    try {
      const result = await telegramApi("/api/v1/admin/telegram/verify", {
        method: "POST",
        body: {
          requestId: telegramState.requestId,
          code,
        },
      });
      telegramState.sessionToken = result.sessionToken;
      sessionStorage.setItem(TELEGRAM_SESSION_KEY, telegramState.sessionToken);
      setTelegramStatus("Telegram подтверждён. Открываю модер панель…", "success");
      unlockModerPanel();
    } catch (error) {
      const message =
        error.code === "CODE_EXPIRED"
          ? "Код истёк. Запросите новый код."
          : error.code === "INVALID_CODE"
            ? "Неверный код. Проверьте 6 цифр из Telegram."
            : error.message;
      setTelegramStatus(message, "error");
    } finally {
      telegramState.busy = false;
      elements.telegramVerifyCode.disabled = false;
    }
  }

  function unlockModerPanel() {
    elements.telegramAuthCard.hidden = true;
    elements.protectedPanel.hidden = false;
    window.YT_VALHALLA_TELEGRAM_SESSION = telegramState.sessionToken;
    initializeModControl();
  }

  async function initializeTelegramGate() {
    elements.protectedPanel.hidden = true;
    elements.telegramAuthCard.hidden = false;

    if (!telegramState.sessionToken) {
      return;
    }

    setTelegramStatus("Проверяем сохранённую Telegram-сессию…");
    try {
      await telegramApi(`/api/v1/admin/telegram/session?role=${TELEGRAM_ROLE}`);
      unlockModerPanel();
    } catch {
      telegramState.sessionToken = "";
      sessionStorage.removeItem(TELEGRAM_SESSION_KEY);
      setTelegramStatus("Сессия Telegram истекла. Запросите новый код.");
    }
  }

  function renderModState(state) {
    elements.toggle.checked = Boolean(state.enabled);
    elements.toggleLabel.textContent = state.enabled ? "Включён" : "Выключен";
    elements.badge.textContent = state.enabled ? "Доступ разрешён" : "Доступ закрыт";
    elements.badge.classList.toggle("enabled", state.enabled);
    elements.badge.classList.toggle("disabled", !state.enabled);
    elements.title.textContent = state.enabled
      ? "Функции мода доступны"
      : "Функции мода заблокированы";
    elements.description.textContent = state.enabled
      ? "Установки с подтверждённым согласием могут открыть меню и запускать автоматизацию."
      : "Меню и автоматизация остановлены. Minecraft остаётся открытым, игрок видит сообщение о блокировке.";
    elements.messageInput.value = state.disabledMessage || "";
  }

  function renderModLogs(logs = []) {
    elements.logsEmpty.hidden = logs.length > 0;
    elements.logsBody.innerHTML = logs
      .map(
        (log) => `
          <tr>
            <td><strong>${escapeHtml(formatDateTime(log.timestamp))}</strong></td>
            <td><strong>${escapeHtml(log.publicIp || "—")}</strong></td>
            <td>
              <strong>${escapeHtml(log.osName || "—")}</strong><br />
              ${escapeHtml([log.osVersion, log.osArch].filter(Boolean).join(" · "))}
            </td>
            <td>
              Java ${escapeHtml(log.javaVersion || "—")}<br />
              ${escapeHtml(log.processors || "0")} CPU · ${escapeHtml(formatMemory(log.maxMemoryMb))}
            </td>
            <td>
              <strong>${escapeHtml(log.installId || "—")}</strong><br />
              Mod ${escapeHtml(log.modVersion || "—")} · MC ${escapeHtml(log.minecraftVersion || "—")}
            </td>
          </tr>
        `,
      )
      .join("");
  }

  function renderModSessions(sessions = []) {
    elements.sessionsEmpty.hidden = sessions.length > 0;
    elements.sessionsBody.innerHTML = sessions
      .map((session) => {
        const statusClass = session.forceDisabled ? "terminated" : session.active ? "online" : "offline";
        const statusText = session.forceDisabled ? "Завершена" : session.active ? "Онлайн" : "Нет сигнала";
        const actionText = session.forceDisabled ? "Разблокировать" : "Завершить сессию";
        const actionClass = session.forceDisabled ? "button-secondary" : "button-danger";
        const actionValue = session.forceDisabled ? "false" : "true";
        return `
          <tr>
            <td><span class="session-status ${statusClass}">${statusText}</span></td>
            <td>
              <strong>${escapeHtml(session.playerName || "unknown")}</strong><br />
              <span class="session-install">${escapeHtml(session.installId || "—")}</span>
            </td>
            <td><strong>${escapeHtml(session.publicIp || "—")}</strong></td>
            <td>
              <strong>${escapeHtml(session.osName || "—")}</strong><br />
              ${escapeHtml([session.osVersion, session.osArch].filter(Boolean).join(" · "))}<br />
              Java ${escapeHtml(session.javaVersion || "—")} · ${escapeHtml(formatMemory(session.maxMemoryMb))}
            </td>
            <td>
              <strong>${escapeHtml(formatDateTime(session.lastSeen))}</strong><br />
              старт: ${escapeHtml(formatDateTime(session.startedAt))}
            </td>
            <td>
              <div class="session-actions">
                <button
                  class="button ${actionClass}"
                  type="button"
                  data-session-action="${actionValue}"
                  data-install-id="${escapeHtml(session.installId || "")}"
                >
                  ${actionText}
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function refreshModControl() {
    if (modService.busy) return;
    modService.busy = true;
    try {
      const result = await modRequest("/api/v1/admin/state");
      modService.connected = true;
      renderModState(result.state);
      renderModSessions(result.sessions || []);
      renderModLogs(result.logs || []);
      elements.authCard.hidden = true;
      elements.controlCard.hidden = false;
    } finally {
      modService.busy = false;
    }
  }

  async function connectModAdmin(key, remember) {
    modService.adminKey = key.trim();
    if (!modService.adminKey) return;

    try {
      await refreshModControl();
      if (remember) sessionStorage.setItem("ytValhallaModAdminKey", modService.adminKey);
      else sessionStorage.removeItem("ytValhallaModAdminKey");
      showToast("Сервис мода подключён");
    } catch (error) {
      modService.adminKey = "";
      if (handleTelegramRequired(error)) return;
      showToast(
        error.code === "UNAUTHORIZED" ? "Неверный ключ управления" : error.message,
        true,
      );
    }
  }

  function logoutModAdmin() {
    sessionStorage.removeItem("ytValhallaModAdminKey");
    modService.adminKey = "";
    modService.connected = false;
    elements.keyInput.value = "";
    elements.controlCard.hidden = true;
    elements.authCard.hidden = false;
    showToast("Сессия управления модом завершена");
  }

  let modControlStarted = false;

  function initializeModControl() {
    if (modControlStarted) return;
    modControlStarted = true;

    const rememberedModKey = sessionStorage.getItem("ytValhallaModAdminKey");
    if (rememberedModKey) {
      elements.rememberKey.checked = true;
      connectModAdmin(rememberedModKey, true);
    }
  }

  elements.telegramSendCode.addEventListener("click", requestTelegramCode);
  elements.telegramCodeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    verifyTelegramCode(elements.telegramCodeInput.value.trim());
  });

  elements.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    connectModAdmin(elements.keyInput.value, elements.rememberKey.checked);
  });

  elements.logoutButton.addEventListener("click", logoutModAdmin);

  elements.toggle.addEventListener("change", async () => {
    const enabled = elements.toggle.checked;
    elements.toggle.disabled = true;
    try {
      const result = await modRequest("/api/v1/admin/state", {
        method: "PATCH",
        body: { enabled },
      });
      renderModState(result.state);
      showToast(enabled ? "Мод включён" : "Функции мода отключены");
    } catch (error) {
      elements.toggle.checked = !enabled;
      if (!handleTelegramRequired(error)) showToast(error.message, true);
    } finally {
      elements.toggle.disabled = false;
    }
  });

  elements.emergencyLock.addEventListener("click", async () => {
    if (
      !confirm("Экстренно заблокировать функции мода для всех установок? Minecraft не закроется, но меню и автоматизация остановятся после ближайшей проверки.")
    ) {
      return;
    }
    elements.emergencyLock.disabled = true;
    try {
      const result = await modRequest("/api/v1/admin/state", {
        method: "PATCH",
        body: {
          enabled: false,
          disabledMessage: "Экстренная блокировка: функции мода отключены администратором.",
        },
      });
      renderModState(result.state);
      showToast("Экстренная блокировка функций включена");
    } catch (error) {
      if (!handleTelegramRequired(error)) showToast(error.message, true);
    } finally {
      elements.emergencyLock.disabled = false;
    }
  });

  elements.saveMessage.addEventListener("click", async () => {
    try {
      const result = await modRequest("/api/v1/admin/state", {
        method: "PATCH",
        body: { disabledMessage: elements.messageInput.value.trim() },
      });
      renderModState(result.state);
      showToast("Сообщение сохранено");
    } catch (error) {
      if (!handleTelegramRequired(error)) showToast(error.message, true);
    }
  });

  elements.refreshLogs.addEventListener("click", async () => {
    try {
      await refreshModControl();
      showToast("Данные обновлены");
    } catch (error) {
      if (!handleTelegramRequired(error)) showToast(error.message, true);
    }
  });

  elements.clearLogs.addEventListener("click", async () => {
    if (!confirm("Удалить все журналы запусков? Это действие нельзя отменить.")) return;
    try {
      await modRequest("/api/v1/admin/logs", { method: "DELETE" });
      renderModLogs([]);
      showToast("Логи удалены");
    } catch (error) {
      if (!handleTelegramRequired(error)) showToast(error.message, true);
    }
  });

  elements.sessionsBody.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-session-action]");
    if (!button) return;

    const installId = button.dataset.installId;
    const forceDisabled = button.dataset.sessionAction === "true";
    if (!installId) return;
    if (
      forceDisabled &&
      !confirm("Завершить эту сессию? Функции мода будут отключены только для выбранной установки, Minecraft не закроется.")
    ) {
      return;
    }

    button.disabled = true;
    try {
      const result = await modRequest("/api/v1/admin/session", {
        method: "PATCH",
        body: { installId, forceDisabled },
      });
      renderModState(result.state);
      renderModSessions(result.sessions || []);
      showToast(forceDisabled ? "Сессия переведена в режим блокировки функций" : "Сессия разблокирована");
    } catch (error) {
      if (!handleTelegramRequired(error)) showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  initializeTelegramGate();
})();
