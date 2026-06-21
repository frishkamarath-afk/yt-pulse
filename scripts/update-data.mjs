import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const apiKey = process.env.YOUTUBE_API_KEY;
const apiBase = "https://www.googleapis.com/youtube/v3";

if (!apiKey) {
  throw new Error("Не задан YOUTUBE_API_KEY. Добавьте ключ в GitHub Actions Secrets.");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(rootDirectory, relativePath), "utf8"));
}

const settings = await readJson("config/keywords.json");
const manualSettings = await readJson("config/channels.json");
const keywords = [...new Set(settings.keywords.map((item) => item.trim()).filter(Boolean))];
const contextTerms = (settings.contextTerms || []).map(normalize).filter(Boolean);

if (keywords.length > 40) {
  throw new Error("Слишком много поисковых фраз. Оставьте не более 40 запросов.");
}

function monthsAgoIso(months) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

function chunks(items, size = 50) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function normalize(value = "") {
  return value
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function metadataText(video) {
  return normalize(
    [
      video.snippet?.title,
      video.snippet?.description,
      ...(video.snippet?.tags || []),
    ].join(" "),
  );
}

function matchedKeywords(video) {
  const text = metadataText(video);
  return keywords.filter((keyword) => text.includes(normalize(keyword)));
}

function hasContext(video) {
  if (!contextTerms.length) return true;
  const text = metadataText(video);
  return contextTerms.some((term) => text.includes(term));
}

function contextualQuery(keyword) {
  const context = normalize(settings.searchContext || "");
  if (!context || normalize(keyword).includes(context)) return keyword;
  return `${keyword} ${settings.searchContext}`;
}

function number(value) {
  return Number.parseInt(value || "0", 10) || 0;
}

function durationSeconds(isoDuration = "") {
  const match = String(isoDuration).match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return 0;
  return (
    number(match[1]) * 86400 +
    number(match[2]) * 3600 +
    number(match[3]) * 60 +
    Number.parseFloat(match[4] || "0")
  );
}

const shortStatusCache = new Map();

async function isYouTubeShort(video, attempt = 1) {
  if (!settings.excludeShorts) return false;

  const maximumShortDuration = number(settings.maxShortDurationSeconds) || 180;
  if (durationSeconds(video.contentDetails?.duration) > maximumShortDuration) return false;
  if (!video.id) return false;
  if (shortStatusCache.has(video.id)) return shortStatusCache.get(video.id);

  try {
    const response = await fetch(`https://www.youtube.com/shorts/${video.id}`, {
      method: "HEAD",
      redirect: "manual",
      headers: {
        Accept: "text/html",
        Cookie: "SOCS=CAI",
        "User-Agent": "YT-Pulse/1.0",
      },
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
      return isYouTubeShort(video, attempt + 1);
    }

    // YouTube serves actual Shorts at /shorts/VIDEO_ID with 200.
    // Regular videos redirect from that address to /watch with 303.
    const isShort = response.status === 200;
    shortStatusCache.set(video.id, isShort);
    return isShort;
  } catch (error) {
    console.warn(`Shorts check failed for ${video.id}: ${error.message}`);
    // On a network failure, exclude videos short enough to be Shorts rather
    // than allowing their inflated Shorts views into long-form statistics.
    shortStatusCache.set(video.id, true);
    return true;
  }
}

async function regularVideosOnly(videos) {
  if (!settings.excludeShorts || !videos.length) return videos;

  const regularVideos = [];
  const concurrency = Math.max(1, number(settings.shortCheckConcurrency) || 12);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < videos.length) {
      const video = videos[nextIndex];
      nextIndex += 1;
      if (!(await isYouTubeShort(video))) regularVideos.push(video);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, videos.length) }, () => worker()),
  );

  return regularVideos.sort((a, b) =>
    (b.snippet?.publishedAt || "").localeCompare(a.snippet?.publishedAt || ""),
  );
}

async function youtube(resource, params, attempt = 1) {
  const url = new URL(`${apiBase}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (response.ok) return response.json();

  const body = await response.text();
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    return youtube(resource, params, attempt + 1);
  }

  throw new Error(`YouTube API ${response.status}: ${body.slice(0, 500)}`);
}

async function videoDetails(videoIds) {
  const details = [];
  for (const batch of chunks([...new Set(videoIds)])) {
    if (!batch.length) continue;
    const response = await youtube("videos", {
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
      maxResults: 50,
    });
    details.push(...(response.items || []));
  }
  return details;
}

async function discoverChannels(cutoff) {
  const discovered = new Map();

  for (const keyword of keywords) {
    console.log(`Поиск: ${keyword}`);
    const response = await youtube("search", {
      part: "snippet",
      type: "video",
      order: "date",
      q: contextualQuery(keyword),
      publishedAfter: cutoff,
      maxResults: Math.min(number(settings.searchResultsPerKeyword) || 10, 50),
      regionCode: settings.regionCode || "RU",
      relevanceLanguage: settings.relevanceLanguage || "ru",
      safeSearch: "none",
    });

    const ids = (response.items || []).map((item) => item.id?.videoId).filter(Boolean);
    const videos = await regularVideosOnly(await videoDetails(ids));

    for (const video of videos) {
      const matches = matchedKeywords(video);
      if (!matches.length || !hasContext(video) || !video.snippet?.channelId) continue;
      const channelId = video.snippet.channelId;
      const current = discovered.get(channelId) || { channelId, keywords: new Set() };
      matches.forEach((match) => current.keywords.add(match));
      discovered.set(channelId, current);
    }

    const channelResponse = await youtube("search", {
      part: "snippet",
      type: "channel",
      order: "relevance",
      q: contextualQuery(keyword),
      maxResults: Math.min(number(settings.channelSearchResultsPerKeyword) || 3, 10),
      regionCode: settings.regionCode || "RU",
      relevanceLanguage: settings.relevanceLanguage || "ru",
      safeSearch: "none",
    });

    for (const item of channelResponse.items || []) {
      const channelId = item.id?.channelId || item.snippet?.channelId;
      const title = normalize(item.snippet?.title);
      if (!channelId || !title.includes(normalize(keyword))) continue;
      const current = discovered.get(channelId) || { channelId, keywords: new Set() };
      current.keywords.add(keyword);
      discovered.set(channelId, current);
    }
  }

  return discovered;
}

function parseChannelReference(reference) {
  const value = String(reference).trim();
  if (/^UC[\w-]{20,}$/.test(value)) return { id: value };
  const channelMatch = value.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (channelMatch) return { id: channelMatch[1] };
  const handleMatch = value.match(/(?:youtube\.com\/)?@([\w.-]+)/i);
  if (handleMatch) return { handle: handleMatch[1] };
  if (value.startsWith("@")) return { handle: value.slice(1) };
  return null;
}

async function resolveManualChannels() {
  const resolved = new Set();

  for (const reference of manualSettings.channels || []) {
    const parsed = parseChannelReference(reference);
    if (!parsed) {
      console.warn(`Не удалось распознать канал: ${reference}`);
      continue;
    }
    if (parsed.id) {
      resolved.add(parsed.id);
      continue;
    }
    const response = await youtube("channels", {
      part: "id",
      forHandle: parsed.handle,
      maxResults: 1,
    });
    const channelId = response.items?.[0]?.id;
    if (channelId) resolved.add(channelId);
    else console.warn(`Канал @${parsed.handle} не найден`);
  }

  return resolved;
}

async function getChannels(channelIds) {
  const channels = [];
  for (const batch of chunks(channelIds)) {
    const response = await youtube("channels", {
      part: "snippet,contentDetails,statistics",
      id: batch.join(","),
      maxResults: 50,
    });
    channels.push(...(response.items || []));
  }
  return channels;
}

async function getUploads(playlistId, cutoff) {
  const items = [];
  let pageToken;
  const maxVideos = Math.max(4, number(settings.maxVideosPerChannel) || 100);

  do {
    const response = await youtube("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: 50,
      pageToken,
    });
    const page = response.items || [];
    items.push(...page);
    pageToken = response.nextPageToken;

    const oldest = page.at(-1)?.contentDetails?.videoPublishedAt || page.at(-1)?.snippet?.publishedAt;
    if (oldest && oldest < cutoff && items.length >= 4) break;
  } while (pageToken && items.length < maxVideos);

  return items
    .slice(0, maxVideos)
    .map((item) => item.contentDetails?.videoId || item.snippet?.resourceId?.videoId)
    .filter(Boolean);
}

function channelOutput(channel, videos, discoveredKeywords, cutoff) {
  const sortedVideos = [...videos].sort((a, b) =>
    (b.snippet?.publishedAt || "").localeCompare(a.snippet?.publishedAt || ""),
  );
  const recentVideos = sortedVideos.filter((video) => (video.snippet?.publishedAt || "") >= cutoff);
  const averageViews = recentVideos.length
    ? Math.round(
        recentVideos.reduce((sum, video) => sum + number(video.statistics?.viewCount), 0) /
          recentVideos.length,
      )
    : 0;

  const foundKeywords = new Set(discoveredKeywords || []);
  videos.forEach((video) => {
    if (!hasContext(video)) return;
    matchedKeywords(video).forEach((keyword) => foundKeywords.add(keyword));
  });

  return {
    channelId: channel.id,
    title: channel.snippet?.title || "Без названия",
    handle: channel.snippet?.customUrl || "",
    url: `https://www.youtube.com/channel/${channel.id}`,
    thumbnail:
      channel.snippet?.thumbnails?.medium?.url ||
      channel.snippet?.thumbnails?.default?.url ||
      "",
    subscribers: number(channel.statistics?.subscriberCount),
    averageViewsPeriod: averageViews,
    videosCountPeriod: recentVideos.length,
    matchedKeywords: [...foundKeywords],
    lastFourVideos: sortedVideos.slice(0, 4).map((video) => ({
      videoId: video.id,
      title: video.snippet?.title || "Без названия",
      url: `https://www.youtube.com/watch?v=${video.id}`,
      publishedAt: video.snippet?.publishedAt,
      views: number(video.statistics?.viewCount),
      comments: number(video.statistics?.commentCount),
    })),
  };
}

async function main() {
  const periodMonths = Math.max(1, number(settings.periodMonths) || 2);
  const minimumAverageViews = Math.max(0, number(settings.minAverageViews) || 200);
  const maximumChannels = Math.max(1, number(settings.maxChannels) || 100);
  const cutoff = monthsAgoIso(periodMonths);
  const discovered = await discoverChannels(cutoff);
  const manualIds = await resolveManualChannels();
  const allIds = [...new Set([...manualIds, ...discovered.keys()])].slice(
    0,
    maximumChannels,
  );

  console.log(`К обработке выбрано каналов: ${allIds.length}`);
  const channels = await getChannels(allIds);
  const output = [];

  for (const channel of channels) {
    const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) continue;
    console.log(`Статистика: ${channel.snippet?.title}`);
    const uploadIds = await getUploads(playlistId, cutoff);
    const videos = await regularVideosOnly(await videoDetails(uploadIds));
    const result = channelOutput(
      channel,
      videos,
      discovered.get(channel.id)?.keywords,
      cutoff,
    );
    if (result.averageViewsPeriod > minimumAverageViews) output.push(result);
  }

  output.sort((a, b) => b.averageViewsPeriod - a.averageViewsPeriod);

  const payload = {
    generatedAt: new Date().toISOString(),
    demo: false,
    source: "youtube-data-api-v3",
    shortsExcluded: Boolean(settings.excludeShorts),
    periodMonths,
    minAverageViews: minimumAverageViews,
    maxChannels: maximumChannels,
    keywords,
    channels: output,
  };

  const destination = path.join(rootDirectory, "data", "channels.json");
  await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Готово: ${output.length} каналов записано в data/channels.json`);
}

await main();
