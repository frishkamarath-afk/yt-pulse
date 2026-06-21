const state = {
  data: null,
  query: "",
  sort: "average-desc",
  openChannelId: null,
};

const elements = {
  body: document.querySelector("#channels-body"),
  empty: document.querySelector("#empty-state"),
  search: document.querySelector("#channel-search"),
  sort: document.querySelector("#channel-sort"),
  resultCount: document.querySelector("#result-count"),
  keywordCount: document.querySelector("#keyword-count"),
  keywordCloud: document.querySelector("#keyword-cloud"),
  updated: document.querySelector("#last-updated"),
  sidebarUpdated: document.querySelector("#sidebar-updated"),
  demoBanner: document.querySelector("#demo-banner"),
  reloadButton: document.querySelector("#reload-button"),
  toast: document.querySelector("#toast"),
  metricChannels: document.querySelector("#metric-channels"),
  metricAverage: document.querySelector("#metric-average"),
  metricViews: document.querySelector("#metric-views"),
  metricComments: document.querySelector("#metric-comments"),
};

const numberFormatter = new Intl.NumberFormat("ru-RU");
const compactFormatter = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const shortDateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function formatCompact(value) {
  return compactFormatter.format(Number(value) || 0);
}

function pluralizeChannels(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} канал`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} канала`;
  return `${count} каналов`;
}

function initials(title) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function avatarMarkup(channel) {
  if (channel.thumbnail) {
    return `<span class="avatar"><img src="${escapeHtml(channel.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`;
  }
  return `<span class="avatar" aria-hidden="true">${escapeHtml(initials(channel.title))}</span>`;
}

function latestPublishedAt(channel) {
  return channel.lastFourVideos?.[0]?.publishedAt || "";
}

function filteredChannels() {
  if (!state.data) return [];
  const query = state.query.trim().toLocaleLowerCase("ru");
  const channels = state.data.channels.filter((channel) => {
    if (!query) return true;
    const haystack = [
      channel.title,
      channel.handle,
      ...(channel.matchedKeywords || []),
    ]
      .join(" ")
      .toLocaleLowerCase("ru");
    return haystack.includes(query);
  });

  return channels.sort((a, b) => {
    if (state.sort === "average-asc") return a.averageViews3Months - b.averageViews3Months;
    if (state.sort === "latest") return latestPublishedAt(b).localeCompare(latestPublishedAt(a));
    if (state.sort === "name") return a.title.localeCompare(b.title, "ru");
    return b.averageViews3Months - a.averageViews3Months;
  });
}

function videoPopover(channel) {
  const videos = channel.lastFourVideos || [];
  const totalViews = videos.reduce((sum, video) => sum + Number(video.views || 0), 0);
  const totalComments = videos.reduce((sum, video) => sum + Number(video.comments || 0), 0);
  const items = videos.length
    ? videos
        .map(
          (video) => `
            <a class="video-item" href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">
              <span>
                <span class="video-title">${escapeHtml(video.title)}</span>
                <span class="video-date">${shortDateFormatter.format(new Date(video.publishedAt))}</span>
              </span>
              <span class="video-numbers">
                <span>▶ <b>${formatNumber(video.views)}</b></span>
                <span>◌ <b>${formatNumber(video.comments)}</b></span>
              </span>
            </a>
          `,
        )
        .join("")
    : `<div class="video-item"><span class="video-title">У канала пока нет доступных роликов</span></div>`;

  return `
    <div class="video-popover" data-popover="${escapeHtml(channel.channelId)}">
      <div class="popover-head">
        <span>
          <strong>Последние 4 ролика</strong>
          <small>Просмотры и комментарии</small>
        </span>
        <button class="popover-close" type="button" aria-label="Закрыть">×</button>
      </div>
      <div class="video-list">${items}</div>
      <div class="popover-total">
        <span>Всего просмотров <b>${formatNumber(totalViews)}</b></span>
        <span>Комментариев <b>${formatNumber(totalComments)}</b></span>
      </div>
    </div>
  `;
}

function channelRow(channel) {
  const keywords = channel.matchedKeywords?.length
    ? channel.matchedKeywords.slice(0, 3).join(" · ")
    : "добавлен вручную";
  const isOpen = state.openChannelId === channel.channelId;

  return `
    <tr data-channel-id="${escapeHtml(channel.channelId)}">
      <td>
        <div class="channel-cell">
          ${avatarMarkup(channel)}
          <div class="channel-copy">
            <strong title="${escapeHtml(channel.title)}">${escapeHtml(channel.title)}</strong>
            <small title="${escapeHtml(keywords)}">${escapeHtml(keywords)}</small>
          </div>
        </div>
      </td>
      <td class="average-cell">
        <strong>${formatCompact(channel.averageViews3Months)}</strong>
        <small>${formatNumber(channel.averageViews3Months)} просмотров</small>
      </td>
      <td class="count-cell">
        <strong>${formatNumber(channel.videosCount3Months)}</strong>
        <small>за период</small>
      </td>
      <td>
        <a class="channel-link" href="${escapeHtml(channel.url)}" target="_blank" rel="noreferrer">
          YouTube
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 5h5v5M10 14 19 5M19 13v6H5V5h6" />
          </svg>
        </a>
      </td>
      <td>
        <button
          class="details-button"
          type="button"
          aria-label="Показать статистику последних роликов канала ${escapeHtml(channel.title)}"
          aria-expanded="${isOpen}"
          data-details="${escapeHtml(channel.channelId)}"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
        ${isOpen ? videoPopover(channel) : ""}
      </td>
    </tr>
  `;
}

function renderChannels() {
  const channels = filteredChannels();
  elements.body.innerHTML = channels.map(channelRow).join("");
  elements.empty.hidden = channels.length > 0;
  elements.resultCount.textContent = pluralizeChannels(channels.length);
}

function renderMetrics() {
  const channels = state.data.channels || [];
  const averages = channels.map((channel) => Number(channel.averageViews3Months || 0));
  const totalAverage = averages.length
    ? Math.round(averages.reduce((sum, value) => sum + value, 0) / averages.length)
    : 0;
  const latestVideos = channels.flatMap((channel) => channel.lastFourVideos || []);
  const totalViews = latestVideos.reduce((sum, video) => sum + Number(video.views || 0), 0);
  const totalComments = latestVideos.reduce((sum, video) => sum + Number(video.comments || 0), 0);

  elements.metricChannels.textContent = formatNumber(channels.length);
  elements.metricAverage.textContent = formatCompact(totalAverage);
  elements.metricViews.textContent = formatCompact(totalViews);
  elements.metricComments.textContent = formatCompact(totalComments);
}

function renderKeywords() {
  const keywords = state.data.keywords || [];
  elements.keywordCount.textContent = `${keywords.length} фраз`;
  elements.keywordCloud.innerHTML = keywords
    .map((keyword) => `<span class="keyword-chip">${escapeHtml(keyword)}</span>`)
    .join("");
}

function renderMetadata() {
  const generatedAt = new Date(state.data.generatedAt);
  const validDate = !Number.isNaN(generatedAt.getTime());
  const text = validDate ? `Обновлено ${dateFormatter.format(generatedAt)}` : "Дата обновления неизвестна";
  elements.updated.textContent = text;
  elements.sidebarUpdated.textContent = validDate ? dateFormatter.format(generatedAt) : "Ожидаем данные";
  elements.demoBanner.hidden = !state.data.demo;
}

function render() {
  renderMetadata();
  renderMetrics();
  renderKeywords();
  renderChannels();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

async function loadData({ manual = false } = {}) {
  elements.reloadButton.classList.add("loading");
  try {
    const response = await fetch(`data/channels.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.channels) || !Array.isArray(payload.keywords)) {
      throw new Error("Некорректная структура данных");
    }
    state.data = payload;
    state.openChannelId = null;
    render();
    if (manual) showToast("Локальные данные перечитаны");
  } catch (error) {
    console.error(error);
    showToast("Не удалось загрузить data/channels.json");
    elements.updated.textContent = "Ошибка загрузки данных";
  } finally {
    elements.reloadButton.classList.remove("loading");
  }
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  state.openChannelId = null;
  renderChannels();
});

elements.sort.addEventListener("change", (event) => {
  state.sort = event.target.value;
  state.openChannelId = null;
  renderChannels();
});

elements.reloadButton.addEventListener("click", () => loadData({ manual: true }));

elements.body.addEventListener("click", (event) => {
  const closeButton = event.target.closest(".popover-close");
  if (closeButton) {
    state.openChannelId = null;
    renderChannels();
    return;
  }

  const detailsButton = event.target.closest("[data-details]");
  if (!detailsButton) return;
  const channelId = detailsButton.dataset.details;
  state.openChannelId = state.openChannelId === channelId ? null : channelId;
  renderChannels();
});

document.addEventListener("click", (event) => {
  if (!state.openChannelId) return;
  if (event.target.closest(".video-popover") || event.target.closest("[data-details]")) return;
  state.openChannelId = null;
  renderChannels();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.openChannelId) {
    state.openChannelId = null;
    renderChannels();
  }
});

loadData();
