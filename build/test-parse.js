/* Оффлайн-проверка background.js: заглушка browser API + разбор ответов VK
   и ID3-тегов. */
const fs = require('fs');
const vm = require('vm');

const listeners = { onBeforeRequest: [] };
const downloaded = [];

global.browser = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {}
    }
  },
  runtime: {
    sendMessage: async () => {},
    onMessage: { addListener: () => {} }
  },
  tabs: { query: async () => [], sendMessage: async () => {} },
  downloads: {
    download: async (opts) => {
      downloaded.push(opts);
      return downloaded.length;
    }
  },
  webRequest: {
    onBeforeRequest: { addListener: (fn, filter, extra) => listeners.onBeforeRequest.push({ fn, filter, extra }) },
    filterResponseData: () => {
      throw new Error('нет потока в тесте');
    }
  }
};

/* ---------- генераторы тестовых ID3 ---------- */

function id3Text(text, encoding) {
  if (encoding === 1) {
    const bom = Buffer.from([0xff, 0xfe]);
    return Buffer.concat([Buffer.from([1]), bom, Buffer.from(text, 'utf16le')]);
  }
  if (encoding === 3) return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  return Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
}

function syncsafeBytes(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function buildId3(version, frames) {
  const parts = [];
  for (const frame of frames) {
    const payload = id3Text(frame.text, frame.encoding || 0);
    if (version === 2) {
      const header = Buffer.alloc(6);
      header.write(frame.id, 0, 'ascii');
      header[3] = (payload.length >> 16) & 0xff;
      header[4] = (payload.length >> 8) & 0xff;
      header[5] = payload.length & 0xff;
      parts.push(header, payload);
      continue;
    }
    const header = Buffer.alloc(10);
    header.write(frame.id, 0, 'ascii');
    if (version === 4) syncsafeBytes(payload.length).copy(header, 4);
    else header.writeUInt32BE(payload.length, 4);
    parts.push(header, payload);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([version, 0, 0]), syncsafeBytes(body.length), body]);
}

const code = fs.readFileSync('vk-music-downloader/background.js', 'utf8');
vm.runInThisContext(code + `
;globalThis.__t = {
  extractAudio, makeTrack, buildFilename, handleApiBody, parseLoose, extractFromText,
  parseId3, titleFromUrl, sanitizeName,
  addTracks, downloadOne, resolveNames,
  get tracks() { return tracks; }
};`, { filename: 'background.js' });

(async () => {
  const { __t } = globalThis;
  const results = [];
  const check = (name, cond, extra) => results.push({ name, ok: Boolean(cond), extra });

  /* 1. Ответ нового формата */
  const modern = {
    response: {
      audios: [
        {
          id: '-2000123456_456239017',
          owner_id: -2000123456,
          artist: 'Linkin Park',
          title: 'Numb',
          duration: 185,
          url: 'https://psv4.userapi.com/s/v1/audios/abc/def/Numb.mp3?extra=token123'
        },
        {
          id: 456239018,
          owner_id: 2000123456,
          subtitle: 'Кино',
          title: 'Группа крови',
          duration: 300,
          files: { mp3_128: 'https://psv4.userapi.com/s/v1/audios/x/y/Gruppa_krovi.mp3' }
        }
      ]
    }
  };

  const items = __t.extractAudio(modern);
  check('разобрано 2 трека', items.length === 2, items.map((i) => i.title));
  check('id из строки', items[0] && items[0].key === 'id:-2000123456_456239017', items[0] && items[0].key);
  check('id из чисел', items[1] && items[1].key === 'id:2000123456_456239018', items[1] && items[1].key);
  check('название и исполнитель', items[0] && items[0].artist === 'Linkin Park' && items[0].title === 'Numb', items[0]);
  check('subtitle как исполнитель', items[1] && items[1].artist === 'Кино', items[1] && items[1].artist);
  check('files.mp3_128', items[1] && items[1].url.includes('Gruppa_krovi.mp3'), items[1] && items[1].url);

  /* 2. Мусор */
  const junk = {
    response: [
      { id: 1, title: 'Сайт', url: 'https://example.com/page.html' },
      { id: 2, title: 'Фото', url: 'https://sun9-1.userapi.com/impg/photo.jpg' },
      { id: 3, title: 'Без ссылки', duration: 100 }
    ]
  };
  check('мусор отфильтрован', __t.extractAudio(junk).length === 0, __t.extractAudio(junk));

  /* 3. Ответ со служебным префиксом и экранированными слэшами */
  const legacy = '<!json>{"payload":[{"id":"5_6","artist":"A","title":"B","url":"https:\\/\\/psv4.userapi.com\\/s\\/v1\\/audios\\/q\\/w\\/B.mp3?extra=1"}]}';
  check('parseLoose с префиксом', __t.parseLoose(legacy) !== null);
  const fromText = __t.extractFromText(legacy);
  check('регулярка достала ссылку', fromText.length === 1 && fromText[0].url.startsWith('https://psv4.userapi.com'), fromText);

  /* 4. Имена файлов */
  check('имя файла', __t.buildFilename(items[0]) === 'ПСС Music/Linkin Park - Numb.mp3', __t.buildFilename(items[0]));
  check('запрещённые символы', __t.buildFilename({ artist: 'AC/DC', title: 'a:b?c*', url: 'https://psv4.userapi.com/a.mp3' }) === 'ПСС Music/AC_DC - a_b_c.mp3');
  check('название из URL', __t.titleFromUrl('https://psv4.userapi.com/s/v1/audios/q/w/Smells_Like_Teen_Spirit.mp3?x=1') === 'Smells Like Teen Spirit', __t.titleFromUrl('https://psv4.userapi.com/s/v1/audios/q/w/Smells_Like_Teen_Spirit.mp3?x=1'));
  check('хеш не становится названием', __t.titleFromUrl('https://psv4.userapi.com/a/deadbeef1234.mp3') === '', __t.titleFromUrl('https://psv4.userapi.com/a/deadbeef1234.mp3'));

  /* 5. ID3 */
  const v23 = buildId3(3, [
    { id: 'TIT2', text: 'Numb', encoding: 1 },
    { id: 'TPE1', text: 'Linkin Park', encoding: 1 }
  ]);
  const t23 = __t.parseId3(new Uint8Array(v23));
  check('ID3v2.3 UTF-16', t23 && t23.title === 'Numb' && t23.artist === 'Linkin Park', t23);

  const v24 = buildId3(4, [
    { id: 'TIT2', text: 'Группа крови', encoding: 3 },
    { id: 'TPE1', text: 'Кино', encoding: 3 }
  ]);
  const t24 = __t.parseId3(new Uint8Array(v24));
  check('ID3v2.4 UTF-8', t24 && t24.title === 'Группа крови' && t24.artist === 'Кино', t24);

  const v22 = buildId3(2, [
    { id: 'TT2', text: 'Nothing Else Matters', encoding: 0 },
    { id: 'TP1', text: 'Metallica', encoding: 0 }
  ]);
  const t22 = __t.parseId3(new Uint8Array(v22));
  check('ID3v2.2', t22 && t22.title === 'Nothing Else Matters' && t22.artist === 'Metallica', t22);

  check('не-ID3 не падает', __t.parseId3(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) === null);

  /* 6. Дедупликация и обновление ссылки */
  await __t.addTracks(items);
  await __t.addTracks([{ ...items[0], url: 'https://psv4.userapi.com/s/v1/audios/abc/def/Numb.mp3?extra=NEW' }]);
  check('дубликат не добавился', __t.tracks.length === 2, __t.tracks.length);
  check('ссылка обновилась', __t.tracks.find((t) => t.key === items[0].key).url.includes('extra=NEW'));

  /* 7. Дозаполнение названий по ID3 (fetch подменён) */
  const id3Bytes = buildId3(3, [
    { id: 'TIT2', text: 'Smells Like Teen Spirit', encoding: 3 },
    { id: 'TPE1', text: 'Nirvana', encoding: 3 }
  ]);
  global.fetch = async () => ({
    ok: true,
    status: 206,
    arrayBuffer: async () => id3Bytes.buffer.slice(id3Bytes.byteOffset, id3Bytes.byteOffset + id3Bytes.byteLength)
  });

  await __t.addTracks([{
    key: 'p:psv4.userapi.com/s/v1/audios/q/w/unknown.mp3',
    audioId: '',
    artist: '',
    title: '',
    duration: 0,
    url: 'https://psv4.userapi.com/s/v1/audios/q/w/unknown.mp3',
    addedAt: Date.now(),
    downloaded: false,
    titleFrom: ''
  }]);

  const before = __t.tracks.find((t) => t.url.includes('unknown.mp3'));
  check('до разбора имени нет', !before.title && !before.artist, before);

  const res = await __t.resolveNames(null, 10);
  const after = (await __t.tracks).find((t) => t.url.includes('unknown.mp3'));
  check('ID3 дал название', after && after.title === 'Smells Like Teen Spirit' && after.artist === 'Nirvana', after);
  check('resolveNames сообщил об изменении', res.changed === true, res);

  /* 8. Скачивание */
  const dl = await __t.downloadOne(__t.tracks.find((t) => t.key === items[1].key).key);
  check('downloads.download вызван', dl.ok === true && downloaded.length === 1, downloaded[0]);

  /* 9. Слушатели webRequest */
  const blocking = listeners.onBeforeRequest.filter((l) => (l.extra || []).includes('blocking'));
  check('один блокирующий слушатель', blocking.length === 1, listeners.onBeforeRequest.length);
  check('широкий фильтр /method/*', blocking[0].filter.urls.some((u) => u.includes('api.vk.com/method/*')), blocking[0].filter.urls.length);
  check('фильтр по *audio*', blocking[0].filter.urls.some((u) => u.includes('*audio*')));

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.ok ? '' : '  →  ' + JSON.stringify(r.extra)));
  }
  console.log(failed ? `\n${failed} проверок провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})();
