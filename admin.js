const GITHUB = {
  owner: "frishkamarath-afk",
  repo: "yt-pulse",
  branch: "main",
  configPath: "config/keywords.json",
  workflow: "update-and-deploy.yml",
};

const MOD_API_ENDPOINT = (window.YT_VALHALLA_MOD_SERVICE?.endpoint || "").replace(/\/+$/, "");
const TELEGRAM_ROLE = "admin";
const TELEGRAM_SESSION_KEY = "ytValhallaTelegramAdminSession";

const state = {
  token: "",
  account: null,
  sha: "",
  config: null,
  originalKeywords: [],
  keywords: [],
  saving: false,
  updating: false,
  started: false,
};

const telegramState = {
  requestId: "",
  sessionToken: sessionStorage.getItem(TELEGRAM_SESSION_KEY) || "",
  busy: false,
};

const elements = {
  protectedAdmin: document.querySelector("#protected-admin"),
  telegramAuthCard: document.querySelector("#telegram-auth-card"),
  telegramSendCode: document.querySelector("#telegram-send-code"),
  telegramCodeForm: document.querySelector("#telegram-code-form"),
  telegramCodeInput: document.querySelector("#telegram-code"),
  telegramVerifyCode: document.querySelector("#telegram-verify-code"),
  telegramStatus: document.querySelector("#telegram-auth-status"),
  authCard: document.querySelector("#auth-card"),
  tokenForm: document.querySelector("#token-form"),
  tokenInput: document.querySelector("#github-token"),
  rememberToken: document.querySelector("#remember-token"),
  editorCard: document.querySelector("#editor-card"),
  accountName: document.querySelector("#account-name"),
  logoutButton: document.querySelector("#logout-button"),
  addForm: document.querySelector("#add-form"),
  keywordInput: document.querySelector("#keyword-input"),
  keywordList: document.querySelector("#keyword-list"),
  keywordTotal: document.querySelector("#keyword-total"),
  changeStatus: document.querySelector("#change-status"),
  resetButton: document.querySelector("#reset-button"),
  saveButton: document.querySelector("#save-button"),
  manualUpdateButton: document.querySelector("#manual-update-button"),
  manualUpdateStatus: document.querySelector("#manual-update-status"),
  manualRunLink: document.querySelector("#manual-run-link"),
  progressCard: document.querySelector("#progress-card"),
  progressTitle: document.querySelector("#progress-title"),
  progressMessage: document.querySelector("#progress-message"),
  successCard: document.querySelector("#success-card"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeKeyword(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function uniqueKeywords(keywords) {
  const seen = new Set();
  return keywords.filter((keyword) => {
    const key = keyword.toLocaleLowerCase("ru");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function keywordsChanged() {
  return JSON.stringify(state.keywords) !== JSON.stringify(state.originalKeywords);
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = new Error(body?.message || `GitHub API: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
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
  } catch (cause) {
    const error = new Error(
      `Не удалось подключиться к VDS API. Откройте ${MOD_API_ENDPOINT}/health на этом компьютере: если страница не открывается, сеть или браузер блокирует домен API.`,
    );
    error.code = "NETWORK_ERROR";
    error.cause = cause;
    throw error;
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

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function setProgress(title, message, visible = true) {
  elements.progressTitle.textContent = title;
  elements.progressMessage.textContent = message;
  elements.progressCard.hidden = !visible;
}

function setTelegramStatus(message, type = "") {
  elements.telegramStatus.textContent = message;
  elements.telegramStatus.classList.toggle("error", type === "error");
  elements.telegramStatus.classList.toggle("success", type === "success");
}

function unlockAdminPanel() {
  elements.telegramAuthCard.hidden = true;
  elements.protectedAdmin.hidden = false;
  window.YT_VALHALLA_TELEGRAM_SESSION = telegramState.sessionToken;
  window.YT_VALHALLA_ADMIN_UNLOCKED = true;
  document.dispatchEvent(new CustomEvent("yt-valhalla-admin-unlocked"));
  initializeKeywordAdmin();
  if (typeof window.initializeModAdmin === "function") {
    window.initializeModAdmin();
  }
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
    setTelegramStatus("Telegram подтверждён. Открываю админ-панель…", "success");
    unlockAdminPanel();
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

async function initializeTelegramGate() {
  elements.protectedAdmin.hidden = true;
  elements.telegramAuthCard.hidden = false;

  if (!telegramState.sessionToken) {
    return;
  }

  setTelegramStatus("Проверяем сохранённую Telegram-сессию…");
  try {
    await telegramApi(`/api/v1/admin/telegram/session?role=${TELEGRAM_ROLE}`);
    unlockAdminPanel();
  } catch {
    telegramState.sessionToken = "";
    sessionStorage.removeItem(TELEGRAM_SESSION_KEY);
    setTelegramStatus("Сессия Telegram истекла. Запросите новый код.");
  }
}

function renderKeywords() {
  elements.keywordTotal.textContent = state.keywords.length;
  elements.keywordList.innerHTML = state.keywords
    .map(
      (keyword, index) => `
        <div class="keyword-item" data-index="${index}">
          <span class="keyword-index">${String(index + 1).padStart(2, "0")}</span>
          <input
            type="text"
            value="${escapeHtml(keyword)}"
            maxlength="100"
            aria-label="Поисковая фраза ${index + 1}"
            data-keyword-input="${index}"
          />
          <button
            class="remove-keyword"
            type="button"
            aria-label="Удалить фразу ${escapeHtml(keyword)}"
            data-remove="${index}"
          >×</button>
        </div>
      `,
    )
    .join("");

  const changed = keywordsChanged();
  const difference = state.keywords.length - state.originalKeywords.length;
  elements.changeStatus.textContent = changed
    ? `Есть несохранённые изменения${difference ? ` · ${difference > 0 ? "+" : ""}${difference} фраз` : ""}`
    : "Изменений нет";
  elements.resetButton.disabled = !changed || state.saving;
  elements.saveButton.disabled =
    !changed || state.saving || state.keywords.length === 0 || state.keywords.length > 40;
  elements.manualUpdateButton.disabled = state.saving || state.updating;
}

async function loadRepositoryConfig() {
  const file = await github(
    `/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${GITHUB.configPath}?ref=${GITHUB.branch}&t=${Date.now()}`,
  );
  const config = JSON.parse(base64ToUtf8(file.content));
  if (!Array.isArray(config.keywords)) throw new Error("В конфигурации отсутствует список keywords");

  state.sha = file.sha;
  state.config = config;
  state.originalKeywords = config.keywords.map(normalizeKeyword).filter(Boolean);
  state.keywords = [...state.originalKeywords];
}

async function connect(token, remember = false) {
  state.token = token.trim();
  if (!state.token) return;

  setProgress("Подключаемся к GitHub…", "Проверяем аккаунт и права на репозиторий.");
  elements.successCard.hidden = true;

  try {
    state.account = await github("/user");
    await loadRepositoryConfig();

    if (remember) sessionStorage.setItem("ytPulseAdminToken", state.token);
    else sessionStorage.removeItem("ytPulseAdminToken");

    elements.accountName.textContent = `@${state.account.login}`;
    elements.authCard.hidden = true;
    elements.editorCard.hidden = false;
    renderKeywords();
    showToast("GitHub подключён");
  } catch (error) {
    state.token = "";
    const message =
      error.status === 401
        ? "Токен не принят GitHub"
        : error.status === 403
          ? "У токена недостаточно прав"
          : error.status === 404
            ? "Нет доступа к config/keywords.json"
            : error.message;
    showToast(message, true);
  } finally {
    setProgress("", "", false);
  }
}

function addKeywords(rawValue) {
  const additions = rawValue
    .split(/[,\n;]/)
    .map(normalizeKeyword)
    .filter(Boolean);
  const next = uniqueKeywords([...state.keywords, ...additions]);
  if (next.length > 40) {
    showToast("Можно сохранить не больше 40 поисковых фраз", true);
    return;
  }
  if (next.length === state.keywords.length) {
    showToast("Такие фразы уже есть");
    return;
  }
  state.keywords = next;
  elements.keywordInput.value = "";
  renderKeywords();
}

async function saveChanges() {
  if (!keywordsChanged() || state.saving) return;
  const cleaned = uniqueKeywords(state.keywords.map(normalizeKeyword).filter(Boolean));
  if (!cleaned.length || cleaned.length > 40) {
    showToast("Оставьте от 1 до 40 уникальных фраз", true);
    return;
  }

  state.saving = true;
  state.keywords = cleaned;
  renderKeywords();
  elements.successCard.hidden = true;
  setProgress("Сохраняем поисковые фразы…", "Создаём коммит в GitHub.");

  try {
    // Refresh SHA immediately before writing so another statistics commit
    // cannot cause a stale-file conflict.
    await loadRepositoryConfig();
    state.config.keywords = cleaned;
    const content = `${JSON.stringify(state.config, null, 2)}\n`;

    const result = await github(
      `/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${GITHUB.configPath}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: "chore: update search keywords from admin panel",
          content: utf8ToBase64(content),
          sha: state.sha,
          branch: GITHUB.branch,
        }),
      },
    );

    state.sha = result.content.sha;
    state.originalKeywords = [...cleaned];
    state.keywords = [...cleaned];

    setProgress("Фразы сохранены", "Запускаем сбор свежей статистики YouTube.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await github(
      `/repos/${GITHUB.owner}/${GITHUB.repo}/actions/workflows/${GITHUB.workflow}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref: GITHUB.branch }),
      },
    );

    renderKeywords();
    elements.successCard.hidden = false;
    showToast("Обновление сайта запущено");
  } catch (error) {
    const message =
      error.status === 403
        ? "Нужны права Contents: write и Actions: write"
        : error.status === 409
          ? "Файл изменился. Перезагрузите настройки и попробуйте снова."
          : error.message;
    showToast(message, true);
  } finally {
    state.saving = false;
    setProgress("", "", false);
    renderKeywords();
  }
}

async function findLatestManualRun() {
  const runs = await github(
    `/repos/${GITHUB.owner}/${GITHUB.repo}/actions/workflows/${GITHUB.workflow}/runs?branch=${GITHUB.branch}&event=workflow_dispatch&per_page=1&t=${Date.now()}`,
  );
  return runs?.workflow_runs?.[0] || null;
}

async function triggerManualUpdate() {
  if (state.saving || state.updating) return;

  state.updating = true;
  elements.successCard.hidden = true;
  elements.manualRunLink.hidden = true;
  elements.manualUpdateButton.disabled = true;
  elements.manualUpdateStatus.textContent = "Запускаем обновление…";
  setProgress(
    "Запускаем обновление каналов…",
    "GitHub Action соберёт свежую статистику YouTube и заново опубликует сайт.",
  );

  try {
    await github(
      `/repos/${GITHUB.owner}/${GITHUB.repo}/actions/workflows/${GITHUB.workflow}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({ ref: GITHUB.branch }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 1800));
    const latestRun = await findLatestManualRun().catch(() => null);

    if (latestRun?.html_url) {
      elements.manualRunLink.href = latestRun.html_url;
      elements.manualRunLink.hidden = false;
    }

    elements.manualUpdateStatus.textContent = "Обновление запущено";
    elements.successCard.hidden = false;
    showToast("Ручное обновление каналов запущено");
  } catch (error) {
    const message =
      error.status === 403
        ? "Нужны права Actions: write для запуска обновления"
        : error.status === 404
          ? "Workflow обновления не найден или нет доступа"
          : error.message;
    elements.manualUpdateStatus.textContent = "Не удалось запустить";
    showToast(message, true);
  } finally {
    state.updating = false;
    setProgress("", "", false);
    renderKeywords();
  }
}

function logout() {
  sessionStorage.removeItem("ytPulseAdminToken");
  state.token = "";
  state.account = null;
  state.config = null;
  state.keywords = [];
  state.originalKeywords = [];
  elements.tokenInput.value = "";
  elements.editorCard.hidden = true;
  elements.successCard.hidden = true;
  elements.authCard.hidden = false;
  showToast("Сессия завершена");
}

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connect(elements.tokenInput.value, elements.rememberToken.checked);
});

elements.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addKeywords(elements.keywordInput.value);
});

elements.keywordList.addEventListener("input", (event) => {
  const input = event.target.closest("[data-keyword-input]");
  if (!input) return;
  state.keywords[Number(input.dataset.keywordInput)] = input.value;
  const changed = keywordsChanged();
  elements.changeStatus.textContent = changed ? "Есть несохранённые изменения" : "Изменений нет";
  elements.resetButton.disabled = !changed || state.saving;
  elements.saveButton.disabled = !changed || state.saving;
});

elements.keywordList.addEventListener("change", (event) => {
  const input = event.target.closest("[data-keyword-input]");
  if (!input) return;
  const index = Number(input.dataset.keywordInput);
  const cleaned = normalizeKeyword(input.value);
  if (!cleaned) {
    state.keywords.splice(index, 1);
  } else {
    state.keywords[index] = cleaned;
    state.keywords = uniqueKeywords(state.keywords);
  }
  renderKeywords();
});

elements.keywordList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  state.keywords.splice(Number(button.dataset.remove), 1);
  renderKeywords();
});

elements.resetButton.addEventListener("click", () => {
  state.keywords = [...state.originalKeywords];
  renderKeywords();
});

elements.saveButton.addEventListener("click", saveChanges);
elements.manualUpdateButton.addEventListener("click", triggerManualUpdate);
elements.logoutButton.addEventListener("click", logout);

const rememberedToken = sessionStorage.getItem("ytPulseAdminToken");
function initializeKeywordAdmin() {
  if (state.started) return;
  state.started = true;
  if (rememberedToken) {
    elements.rememberToken.checked = true;
    connect(rememberedToken, true);
  }
}

elements.telegramSendCode.addEventListener("click", requestTelegramCode);
elements.telegramCodeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  verifyTelegramCode(elements.telegramCodeInput.value.trim());
});

initializeTelegramGate();
