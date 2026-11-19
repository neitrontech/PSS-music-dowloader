'use strict';

/**
 * ПСС Music Downloader — фоновая страница.
 *
 * Что делает:
 *  1) перехватывает ответы внутреннего API сервиса и достаёт из них ссылки на mp3
 *     вместе с названием/исполнителем;
 *  2) если ответ пришёл без метаданных (или API не перехватился) — дочитывает
 *     ID3-теги из самого файла и берёт название оттуда;
 *  3) скачивает файлы в «Загрузки/ПСС Music».
 *
 * Ничего не обходит: используются только ссылки, которые сервис выдаёт
 * авторизованной сессии пользователя.
 */

const api = browser;

const STORE_KEY = 'vkdl.tracks';
const MAX_TRACKS = 400;
const BODY_LIMIT = 4 * 1024 * 1024;
const MAX_DEBUG = 40;
const NAME_CONCURRENCY = 3;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus)(?:[?#]|$)/i;

/** Ответы каких адресов разбираем. Сервис часто меняет эндпоинты — берём широко. */
const API_URLS = [
  '*://api.vk.com/method/*',
  '*://api.vk.ru/method/*',
  '*://vk.com/method/*',
  '*://vk.ru/method/*',
  '*://*.vk.com/method/*',
  '*://*.vk.ru/method/*',
  '*://*.vk.me/method/*',
  '*://vk.com/al_audio.php*',
  '*://vk.ru/al_audio.php*',
  '*://*.vk.com/al_audio.php*',
  '*://*.vk.ru/al_audio.php*',
  '*://vk.com/api.php*',
  '*://vk.ru/api.php*',
  '*://vk.com/*audio*',
  '*://vk.ru/*audio*',
  '*://*.vk.com/*audio*',
  '*://*.vk.ru/*audio*',
  '*://vk.com/*music*',
  '*://vk.ru/*music*',
  '*://*.vk.com/*music*',
  '*://*.vk.ru/*music*'
];

/** Хосты, с которых сервис отдаёт сами файлы. */
const AUDIO_HOSTS = /(^|\.)(userapi\.(com|ru)|mycdn\.me|vk\.(com|ru)|vkuser\.net|okcdn\.ru)$/i;

let tracks = [];
const seenKeys = new Set();
let saveTimer = null;
let resolveTimer = null;
let debugLog = [];

/* ------------------------------- утилиты -------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sanitizeName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[._\- ]+$/, '')
    .slice(0, 100);
}

function extFromUrl(url) {
  const m = AUDIO_EXT.exec(String(url || ''));
  return m ? m[1].toLowerCase() : 'mp3';
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch (e) {
    return String(url || '').split('?')[0];
  }
}

function basenameOf(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() || '';
    return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '');
  } catch (e) {
    return '';
  }
}

/** Название из имени файла — на случай, когда ни API, ни ID3 не помогли. */
function titleFromUrl(url) {
  const base = basenameOf(url);
  if (!base || base.length < 3) return '';
  if (/^[0-9a-f]{8,}$/i.test(base)) return '';
  const cleaned = base.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 3) return '';
  return cleaned;
}

function looksAudioUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (AUDIO_EXT.test(url)) return true;
  if (/\/audios?\//i.test(url)) return true;
  return false;
}

function joinChunks(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out;
}

function debugAdd(entry) {
  debugLog.unshift({ t: Date.now(), ...entry });
  if (debugLog.length > MAX_DEBUG) debugLog.length = MAX_DEBUG;
}

/* --------------------------- разбор ответа API --------------------------- */

/** Превращает объект из ответа сервиса в запись трека (или null). */
function makeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let url = typeof raw.url === 'string' ? raw.url : '';
  if (!url && raw.files && typeof raw.files === 'object') {
    url = raw.files.mp3_256 || raw.files.mp3_128 || raw.files.mp3_64 || '';
  }
  if (!url || !looksAudioUrl(url)) return null;

  const artist = decodeEntities(pickString(
    raw.artist,
    raw.performer,
    raw.artist_name,
    raw.subtitle,
    raw.author,
    Array.isArray(raw.main_artists) && raw.main_artists[0] && raw.main_artists[0].name,
    Array.isArray(raw.artists) && raw.artists[0] && raw.artists[0].name
  ));
  const title = decodeEntities(pickString(raw.title, raw.track_title, raw.song));
  if (!artist && !title) return null;

  let audioId = '';
  if (typeof raw.id === 'string' && /^-?\d+_\d+$/.test(raw.id)) {
    audioId = raw.id;
  } else if (raw.owner_id != null && raw.id != null) {
    audioId = raw.owner_id + '_' + raw.id;
  }

  return {
    key: audioId ? 'id:' + audioId : 'p:' + pathOf(url),
    audioId,
    artist,
    title,
    duration: Number(raw.duration) || 0,
    url,
    addedAt: Date.now(),
    downloaded: false,
    titleFrom: title ? 'api' : ''
  };
}

/** Обходит JSON-дерево и собирает все похожие на треки объекты. */
function extractAudio(root) {
  const out = [];
  const localSeen = new Set();
  const stack = [[root, 0]];

  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object' || depth > 16) continue;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push([node[i], depth + 1]);
      continue;
    }

    const track = makeTrack(node);
    if (track && !localSeen.has(track.key)) {
      localSeen.add(track.key);
      out.push(track);
    }

    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') stack.push([value, depth + 1]);
    }
  }
  return out;
}

/** Страховка: если JSON не разобрался, вытаскиваем ссылки регуляркой. */
function extractFromText(text) {
  const out = [];
  const localSeen = new Set();
  const re = /https?:\\?\/\\?\/[^"'\s]{5,600}?\.(?:mp3|m4a|aac|ogg)(?:\?[^"'\s]*)?/gi;
  let match;

  while ((match = re.exec(text)) !== null) {
    const url = match[0].replace(/\\\//g, '/');
    if (!looksAudioUrl(url)) continue;
    const key = 'p:' + pathOf(url);
    if (localSeen.has(key)) continue;
    localSeen.add(key);
    out.push({
      key,
      audioId: '',
      artist: '',
      title: titleFromUrl(url),
      duration: 0,
      url,
      addedAt: Date.now(),
      downloaded: false,
      titleFrom: titleFromUrl(url) ? 'url' : ''
    });
  }
  return out;
}

function parseLoose(text) {
  const candidates = [text];
  const first = text.search(/[[{]/);
  if (first > 0) candidates.push(text.slice(first));
  const decoded = decodeEntities(text);
  if (decoded !== text) candidates.push(decoded);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      /* пробуем следующий вариант */
    }
  }
  return null;
}

function handleApiBody(text) {
  if (!text || text.length < 20) return;
  if (!/mp3|m4a|audio|\.m3u8/i.test(text)) return;

  const data = parseLoose(text);
  let items = data ? extractAudio(data) : [];
  if (!items.length) items = extractFromText(text);

  if (items.length) {
    addTracks(items);
    scheduleNameResolution();
  }
}

/* ------------------------------ хранилище -------------------------------- */

async function loadStore() {
  try {
    const stored = await api.storage.local.get(STORE_KEY);
    const list = Array.isArray(stored[STORE_KEY]) ? stored[STORE_KEY] : [];
    for (const item of list) {
      if (!item || !item.key || seenKeys.has(item.key)) continue;
      seenKeys.add(item.key);
      tracks.push(item);
    }
  } catch (e) {
    console.warn('[vkdl] не удалось прочитать хранилище', e);
  }
}

const storeReady = loadStore();

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.storage.local.set({ [STORE_KEY]: tracks }).catch((e) => {
      console.warn('[vkdl] не удалось сохранить список', e);
    });
  }, 250);
}

function notify() {
  api.runtime.sendMessage({ type: 'tracks-changed', count: tracks.length }).catch(() => {});
}

async function addTracks(items) {
  await storeReady;

  let changed = false;

  for (const item of items) {
    if (!item || !item.key) continue;

    const existing = tracks.find((t) => t.key === item.key);
    if (existing) {
      let touched = false;
      if (item.url && item.url !== existing.url) {
        existing.url = item.url; // ссылка живёт ограниченное время — обновляем
        touched = true;
      }
      if (item.title && (!existing.title || existing.titleFrom === 'url')) {
        existing.title = item.title;
        existing.titleFrom = item.titleFrom || 'api';
        touched = true;
      }
      if (item.artist && !existing.artist) {
        existing.artist = item.artist;
        touched = true;
      }
      if (!existing.duration && item.duration) {
        existing.duration = item.duration;
        touched = true;
      }
      if (touched) changed = true;
      continue;
    }

    // Тот же файл мог попасть в список раньше без названия (из регулярки).
    const path = pathOf(item.url);
    for (let i = tracks.length - 1; i >= 0; i -= 1) {
      if (pathOf(tracks[i].url) === path) {
        seenKeys.delete(tracks[i].key);
        tracks.splice(i, 1);
        changed = true;
      }
    }

    seenKeys.add(item.key);
    tracks.unshift(item);
    changed = true;
  }

  if (!changed) return;

  if (tracks.length > MAX_TRACKS) {
    const dropped = tracks.splice(MAX_TRACKS);
    for (const item of dropped) seenKeys.delete(item.key);
  }

  persist();
  notify();
}

/* --------------------------- ID3-теги из файла --------------------------- */

function syncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f);
}

function uint32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3];
}

function decodeTagText(payload) {
  if (!payload.length) return '';
  const encoding = payload[0];
  let body = payload.subarray(1);
  let text = '';

  try {
    if (encoding === 0) {
      text = new TextDecoder('iso-8859-1').decode(body);
    } else if (encoding === 2) {
      text = new TextDecoder('utf-16be').decode(body);
    } else if (encoding === 1) {
      if (body[0] === 0xff && body[1] === 0xfe) {
        text = new TextDecoder('utf-16le').decode(body.subarray(2));
      } else if (body[0] === 0xfe && body[1] === 0xff) {
        text = new TextDecoder('utf-16be').decode(body.subarray(2));
      } else {
        text = new TextDecoder('utf-16le').decode(body);
      }
    } else {
      text = new TextDecoder('utf-8').decode(body);
    }
  } catch (e) {
    return '';
  }

  return text.replace(/\u0000.*/s, '').trim();
}

/** Минимальный парсер ID3v2.2/2.3/2.4: только название и исполнитель. */
function parseId3(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return null;

  const version = bytes[3];
  const flags = bytes[5];
  const size = syncsafe(bytes, 6);
  const end = Math.min(bytes.length, 10 + size);
  let pos = 10;

  if (flags & 0x40) {
    if (version === 4) pos += syncsafe(bytes, 10);
    else pos += uint32(bytes, 10) + 4;
  }

  const result = {};

  if (version === 2) {
    while (pos + 6 <= end) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2]);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const frameSize = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
      if (!frameSize || pos + 6 + frameSize > end) break;
      const payload = bytes.subarray(pos + 6, pos + 6 + frameSize);
      if (id === 'TT2') result.title = decodeTagText(payload);
      else if (id === 'TP1') result.artist = decodeTagText(payload);
      pos += 6 + frameSize;
    }
    return result;
  }

  if (version !== 3 && version !== 4) return null;

  while (pos + 10 <= end) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version === 4 ? syncsafe(bytes, pos + 4) : uint32(bytes, pos + 4);
    if (!frameSize || pos + 10 + frameSize > end) break;
    const payload = bytes.subarray(pos + 10, pos + 10 + frameSize);
    if (id === 'TIT2') result.title = decodeTagText(payload);
    else if (id === 'TPE1') result.artist = decodeTagText(payload);
    pos += 10 + frameSize;
  }

  return result;
}

async function readId3(track) {
  try {
    const response = await fetch(track.url, {
      headers: { Range: 'bytes=0-262143' },
      credentials: 'include'
    });
    if (!response.ok && response.status !== 206) {
      debugAdd({ id3: 'http ' + response.status, path: pathOf(track.url) });
      return null;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const tags = parseId3(buffer);
    debugAdd({ id3: tags ? Object.keys(tags).join(',') : 'нет тегов', path: pathOf(track.url) });
    return tags;
  } catch (e) {
    debugAdd({ id3: 'ошибка: ' + String(e.message || e), path: pathOf(track.url) });
    return null;
  }
}

let resolving = false;

/** Дозаполняет названия по ID3 для треков, где метаданных нет. */
async function resolveNames(keys, limit) {
  await storeReady;
  if (resolving) return { resolved: 0, changed: false };
  resolving = true;

  try {
    const wanted = Array.isArray(keys) && keys.length ? new Set(keys) : null;
    const targets = tracks
      .filter((t) => (!wanted || wanted.has(t.key)) && (!t.artist || !t.title) && !t.tagChecked)
      .slice(0, limit || 40);

    let changed = false;
    let cursor = 0;

    const worker = async () => {
      while (cursor < targets.length) {
        const track = targets[cursor];
        cursor += 1;
        const tags = await readId3(track);
        track.tagChecked = true;
        if (!tags) continue;
        if (tags.title && (!track.title || track.titleFrom === 'url')) {
          track.title = sanitizeName(tags.title) || track.title;
          track.titleFrom = 'id3';
          changed = true;
        }
        if (tags.artist && !track.artist) {
          track.artist = sanitizeName(tags.artist);
          changed = true;
        }
      }
    };

    await Promise.all(Array.from({ length: NAME_CONCURRENCY }, worker));

    if (changed) {
      persist();
      notify();
    }
    return { resolved: targets.length, changed };
  } finally {
    resolving = false;
  }
}

function scheduleNameResolution() {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(() => {
    resolveNames(null, 20).catch(() => {});
  }, 6000);
}

/* --------------------------- перехват ответов ---------------------------- */

function interceptApi(details) {
  let filter;
  try {
    filter = api.webRequest.filterResponseData(details.requestId);
  } catch (e) {
    return {};
  }

  const chunks = [];
  let size = 0;

  filter.ondata = (event) => {
    try {
      if (size < BODY_LIMIT) {
        chunks.push(event.data);
        size += event.data.byteLength;
      }
      filter.write(event.data);
    } catch (e) {
      /* поток закрыт */
    }
  };

  filter.onstop = () => {
    try {
      filter.disconnect();
    } catch (e) {
      /* ignore */
    }
    if (!chunks.length) return;

    try {
      const text = new TextDecoder('utf-8').decode(joinChunks(chunks, size));
      debugAdd({
        url: details.url.split('?')[0],
        len: text.length,
        sample: text.slice(0, 300).replace(/\?[^"'\s]*/g, '?…')
      });
      handleApiBody(text);
    } catch (e) {
      console.warn('[vkdl] не удалось разобрать ответ', e);
    }
  };

  filter.onerror = () => {
    try {
      filter.disconnect();
    } catch (e) {
      /* ignore */
    }
  };

  return {};
}

api.webRequest.onBeforeRequest.addListener(
  interceptApi,
  { urls: API_URLS, types: ['xmlhttprequest', 'other'] },
  ['blocking']
);

/** Страховка: сам файл запросили напрямую (плеер), метаданных в запросе нет. */
api.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!AUDIO_EXT.test(details.url)) return;
    const key = 'p:' + pathOf(details.url);
    if (seenKeys.has(key)) return;
    const title = titleFromUrl(details.url);
    addTracks([{
      key,
      audioId: '',
      artist: '',
      title,
      duration: 0,
      url: details.url,
      addedAt: Date.now(),
      downloaded: false,
      titleFrom: title ? 'url' : ''
    }]).then(() => scheduleNameResolution());
  },
  { urls: ['*://*.userapi.com/*', '*://*.userapi.ru/*', '*://*.mycdn.me/*', '*://*.vkuser.net/*'], types: ['media'] }
);

/* ----------------------------- скачивание -------------------------------- */

function buildFilename(track) {
  const artist = sanitizeName(track.artist) || 'Неизвестный исполнитель';
  const title = sanitizeName(track.title) || sanitizeName(basenameOf(track.url)) || 'Трек';
  return `ПСС Music/${artist} - ${title}.${extFromUrl(track.url)}`;
}

function markDownloaded(track, downloadId) {
  track.downloaded = true;
  track.downloadId = downloadId;
  persist();
  notify();
}

async function downloadViaBlob(track, filename, cause) {
  try {
    const response = await fetch(track.url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    if (!blob.size) throw new Error('пустой файл');

    const objectUrl = URL.createObjectURL(blob);
    const downloadId = await api.downloads.download({
      url: objectUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    markDownloaded(track, downloadId);
    return { ok: true, id: downloadId };
  } catch (error) {
    const first = cause ? String(cause.message || cause) : '';
    const second = String(error.message || error);
    return { ok: false, error: first ? `${second} (прямая загрузка: ${first})` : second };
  }
}

async function downloadOne(key) {
  await storeReady;

  const track = tracks.find((t) => t.key === key);
  if (!track) return { ok: false, error: 'трек не найден в списке' };

  if (!track.title || !track.artist) {
    try {
      await resolveNames([key]);
    } catch (e) {
      /* имя не критично */
    }
  }

  const filename = buildFilename(track);

  try {
    const downloadId = await api.downloads.download({
      url: track.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    markDownloaded(track, downloadId);
    return { ok: true, id: downloadId };
  } catch (error) {
    return downloadViaBlob(track, filename, error);
  }
}

async function downloadAll(list) {
  await storeReady;

  const target = Array.isArray(list) && list.length
    ? list
    : tracks.filter((t) => !t.downloaded).map((t) => t.key);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < target.length; i += 1) {
    const result = await downloadOne(target[i]);
    if (result.ok) ok += 1;
    else fail += 1;

    api.runtime
      .sendMessage({ type: 'progress', done: i + 1, total: target.length, ok, fail })
      .catch(() => {});

    if (i < target.length - 1) await sleep(350);
  }

  return { ok, fail, total: target.length };
}

/* ------------------------------- сообщения ------------------------------- */

function publicTracks() {
  return tracks.map((t) => ({
    key: t.key,
    artist: t.artist,
    title: t.title,
    duration: t.duration,
    url: t.url,
    downloaded: Boolean(t.downloaded),
    named: Boolean(t.artist && t.title)
  }));
}

api.runtime.onMessage.addListener((message) => {
  switch (message && message.type) {
    case 'get-tracks':
      return storeReady.then(() => ({ tracks: publicTracks(), count: tracks.length }));

    case 'resolve-names':
      return resolveNames(message.keys);

    case 'download':
      return downloadOne(message.key);

    case 'download-all':
      return downloadAll(message.keys);

    case 'get-debug':
      return Promise.resolve({ entries: debugLog.slice(0, MAX_DEBUG), count: tracks.length });

    case 'remove': {
      const index = tracks.findIndex((t) => t.key === message.key);
      if (index >= 0) {
        seenKeys.delete(tracks[index].key);
        tracks.splice(index, 1);
        persist();
        notify();
      }
      return Promise.resolve({ ok: true });
    }

    case 'clear':
      tracks = [];
      seenKeys.clear();
      persist();
      notify();
      return Promise.resolve({ ok: true });

    default:
      return undefined;
  }
});
