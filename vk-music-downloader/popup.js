'use strict';

const api = browser;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const filterEl = document.getElementById('filter');
const allBtn = document.getElementById('all');
const clearBtn = document.getElementById('clear');
const diagBtn = document.getElementById('diag');

let tracks = [];
let filterText = '';
let busy = false;
let resolvingNames = false;

function formatDuration(seconds) {
  const total = Number(seconds) || 0;
  if (!total) return '';
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return m + ':' + s;
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.title = text;
}

function rowElement(track) {
  const row = document.createElement('div');
  row.className = 'row';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const title = document.createElement('div');
  title.className = 't' + (track.title ? '' : ' dim');
  title.textContent = track.title || 'Без названия';
  title.title = track.title || '';

  const sub = document.createElement('div');
  sub.className = 'a';
  sub.textContent = [track.artist || 'Неизвестный исполнитель', formatDuration(track.duration)]
    .filter(Boolean)
    .join(' · ');
  sub.title = track.artist || '';

  meta.appendChild(title);
  meta.appendChild(sub);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dl' + (track.downloaded ? ' done' : '');
  button.dataset.key = track.key;
  button.textContent = track.downloaded ? '✓' : 'Скачать';
  button.addEventListener('click', () => downloadOne(track.key, button));

  row.appendChild(meta);
  row.appendChild(button);
  return row;
}

function render() {
  const query = filterText.trim().toLowerCase();
  const shown = query
    ? tracks.filter((t) => ((t.artist || '') + ' ' + (t.title || '')).toLowerCase().includes(query))
    : tracks;

  countEl.textContent = String(tracks.length);

  const isEmpty = tracks.length === 0;
  emptyEl.style.display = isEmpty ? 'block' : 'none';
  listEl.style.display = isEmpty ? 'none' : 'block';

  listEl.textContent = '';
  for (const track of shown) listEl.appendChild(rowElement(track));
}

async function refresh() {
  try {
    const response = await api.runtime.sendMessage({ type: 'get-tracks' });
    tracks = (response && response.tracks) || [];
  } catch (e) {
    tracks = [];
  }
  render();
}

/** Просит фон дочитать ID3-теги для треков без названия. */
async function ensureNames() {
  if (resolvingNames) return;
  const unnamed = tracks.filter((t) => !t.named).map((t) => t.key);
  if (!unnamed.length) return;

  resolvingNames = true;
  setStatus(`Подтягиваю названия (${unnamed.length})…`);
  try {
    const result = await api.runtime.sendMessage({ type: 'resolve-names', keys: unnamed.slice(0, 40) });
    await refresh();
    setStatus(result && result.changed ? 'Названия обновлены' : 'Готово');
  } catch (e) {
    setStatus('Не удалось прочитать теги');
  } finally {
    resolvingNames = false;
  }
}

async function downloadOne(key, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = '…';
  try {
    const result = await api.runtime.sendMessage({ type: 'download', key });
    if (result && result.ok) {
      button.textContent = '✓';
      button.classList.add('done');
      setStatus('Сохранено в «Загрузки/ПСС Music»');
      await refresh();
    } else {
      button.textContent = previous;
      setStatus('Не удалось: ' + ((result && result.error) || 'неизвестная ошибка'));
    }
  } catch (e) {
    button.textContent = previous;
    setStatus('Не удалось: ' + String(e.message || e));
  } finally {
    button.disabled = false;
  }
}

async function downloadAll() {
  if (busy || !tracks.length) return;

  busy = true;
  allBtn.disabled = true;
  setStatus('Скачиваю…');

  try {
    const result = await api.runtime.sendMessage({ type: 'download-all' });
    const parts = [`Сохранено: ${result.ok}`];
    if (result.fail) parts.push(`с ошибкой: ${result.fail}`);
    setStatus(parts.join(', '));
    await refresh();
  } catch (e) {
    setStatus('Ошибка: ' + String(e.message || e));
  } finally {
    busy = false;
    allBtn.disabled = false;
  }
}

async function saveDiagnostics() {
  try {
    const report = await api.runtime.sendMessage({ type: 'get-debug' });
    const payload = {
      generatedAt: new Date().toISOString(),
      extension: api.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      tracks: tracks.slice(0, 20),
      captures: (report && report.entries) || []
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    await api.downloads.download({
      url,
      filename: 'pss-music-downloader-diagnostics.json',
      saveAs: true
    });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus('Отчёт сохранён');
  } catch (e) {
    setStatus('Отчёт не сохранился: ' + String(e.message || e));
  }
}

filterEl.addEventListener('input', () => {
  filterText = filterEl.value;
  render();
});

allBtn.addEventListener('click', downloadAll);
clearBtn.addEventListener('click', async () => {
  try {
    await api.runtime.sendMessage({ type: 'clear' });
  } catch (e) {
    /* ignore */
  }
  tracks = [];
  render();
  setStatus('Список очищен');
});

diagBtn.addEventListener('click', saveDiagnostics);

api.runtime.onMessage.addListener((message) => {
  if (!message) return;

  if (message.type === 'tracks-changed') {
    refresh().then(ensureNames);
  }

  if (message.type === 'progress') {
    setStatus(`Скачиваю ${message.done} из ${message.total}…`);
  }
});

refresh().then(ensureNames);
