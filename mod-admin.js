const modService = {
  endpoint: (window.YT_VALHALLA_MOD_SERVICE?.endpoint || "").replace(/\/+$/, ""),
  clientKey: window.YT_VALHALLA_MOD_SERVICE?.clientKey || "",
  adminKey: "",
  connected: false,
  busy: false,
};

const modElements = {
  tabs: [...document.querySelectorAll("[data-admin-tab]")],
  panels: [...document.querySelectorAll("[data-admin-panel]")],
  authCard: document.querySelector("#mod-auth-card"),
  authForm: document.querySelector("#mod-auth-form"),
  keyInput: document.querySelector("#mod-admin-key"),
  rememberKey: document.querySelector("#remember-mod-key"),
  controlCard: document.querySelector("#mod-control-card"),
  logoutButton: document.querySelector("#mod-logout-button"),
  toggle: document.querySelector("#mod-enabled-toggle"),
  toggleLabel: document.querySelector("#mod-toggle-label"),
  badge: document.querySelector("#mod-status-badge"),
  title: document.querySelector("#mod-status-title"),
  description: document.querySelector("#mod-status-description"),
  messageInput: document.querySelector("#mod-disabled-message"),
  saveMessage: document.querySelector("#save-mod-message"),
  refreshLogs: document.querySelector("#refresh-mod-logs"),
  clearLogs: document.querySelector("#clear-mod-logs"),
  logsBody: document.querySelector("#mod-logs-body"),
  logsEmpty: document.querySelector("#mod-logs-empty"),
};

function switchAdminTab(tab) {
  modElements.tabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.adminTab === tab);
  });
  modElements.panels.forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== tab;
  });
  sessionStorage.setItem("ytValhallaAdminTab", tab);
}

async function modRequest(path, options = {}) {
  if (!modService.endpoint) {
    throw new Error("Сервис управления ещё не настроен");
  }
  const response = await fetch(`${modService.endpoint}${path}`, {
    method: options.method || "GET",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${modService.adminKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const result = await response.json();
  if (!result.ok) {
    const error = new Error(result.error || "Ошибка сервиса управления");
    error.code = result.code;
    throw error;
  }
  return result;
}

function renderModState(state) {
  modElements.toggle.checked = Boolean(state.enabled);
  modElements.toggleLabel.textContent = state.enabled ? "Включён" : "Выключен";
  modElements.badge.textContent = state.enabled ? "Доступ разрешён" : "Доступ закрыт";
  modElements.badge.classList.toggle("enabled", state.enabled);
  modElements.badge.classList.toggle("disabled", !state.enabled);
  modElements.title.textContent = state.enabled
    ? "Функции мода доступны"
    : "Функции мода заблокированы";
  modElements.description.textContent = state.enabled
    ? "Установки с подтверждённым согласием могут открыть меню и запускать автоматизацию."
    : "Меню и автоматизация остановлены. После следующей проверки клиент Minecraft будет принудительно закрыт.";
  modElements.messageInput.value = state.disabledMessage || "";
}

function formatMemory(value) {
  return `${Number(value || 0).toLocaleString("ru-RU")} МБ`;
}

function renderModLogs(logs = []) {
  modElements.logsEmpty.hidden = logs.length > 0;
  modElements.logsBody.innerHTML = logs
    .map(
      (log) => `
        <tr>
          <td><strong>${escapeHtml(new Date(log.timestamp).toLocaleString("ru-RU"))}</strong></td>
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

async function refreshModControl() {
  if (modService.busy) return;
  modService.busy = true;
  try {
    const result = await modRequest("/api/v1/admin/state");
    modService.connected = true;
    renderModState(result.state);
    renderModLogs(result.logs);
    modElements.authCard.hidden = true;
    modElements.controlCard.hidden = false;
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
  modElements.keyInput.value = "";
  modElements.controlCard.hidden = true;
  modElements.authCard.hidden = false;
  showToast("Сессия управления модом завершена");
}

modElements.tabs.forEach((button) => {
  button.addEventListener("click", () => switchAdminTab(button.dataset.adminTab));
});

modElements.authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectModAdmin(modElements.keyInput.value, modElements.rememberKey.checked);
});

modElements.logoutButton.addEventListener("click", logoutModAdmin);

modElements.toggle.addEventListener("change", async () => {
  const enabled = modElements.toggle.checked;
  modElements.toggle.disabled = true;
  try {
    const result = await modRequest("/api/v1/admin/state", {
      method: "PATCH",
      body: { enabled },
    });
    renderModState(result.state);
    showToast(enabled ? "Мод включён" : "Мод выключен");
  } catch (error) {
    modElements.toggle.checked = !enabled;
    showToast(error.message, true);
  } finally {
    modElements.toggle.disabled = false;
  }
});

modElements.saveMessage.addEventListener("click", async () => {
  try {
    const result = await modRequest("/api/v1/admin/state", {
      method: "PATCH",
      body: { disabledMessage: modElements.messageInput.value.trim() },
    });
    renderModState(result.state);
    showToast("Сообщение сохранено");
  } catch (error) {
    showToast(error.message, true);
  }
});

modElements.refreshLogs.addEventListener("click", async () => {
  try {
    await refreshModControl();
    showToast("Логи обновлены");
  } catch (error) {
    showToast(error.message, true);
  }
});

modElements.clearLogs.addEventListener("click", async () => {
  if (!confirm("Удалить все журналы запусков? Это действие нельзя отменить.")) return;
  try {
    await modRequest("/api/v1/admin/logs", { method: "DELETE" });
    renderModLogs([]);
    showToast("Логи удалены");
  } catch (error) {
    showToast(error.message, true);
  }
});

const initialTab = sessionStorage.getItem("ytValhallaAdminTab") || "keywords";
switchAdminTab(initialTab);

const rememberedModKey = sessionStorage.getItem("ytValhallaModAdminKey");
if (rememberedModKey) {
  modElements.rememberKey.checked = true;
  connectModAdmin(rememberedModKey, true);
}
