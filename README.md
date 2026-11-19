# ПСС Music Downloader

Расширение для Firefox: сохраняет треки в MP3, чтобы слушать их офлайн.

Работает на `vk.ru` / `vk.com` — перехватывает ответы внутреннего API, в которых
сайт отдаёт ссылки на файлы, и складывает треки в список с кнопками скачивания.
Названия берутся из ответа API, из ID3-тегов самого файла или из имени файла в
ссылке.

## Структура

```
vk-music-downloader/     исходники расширения (Manifest V2)
  manifest.json
  background.js          перехват ответов, разбор, ID3, скачивание
  popup.html/js/css      интерфейс на панели браузера
  icons/                 иконки 48/96/128
build/                   сборка и проверки
  make-icons.py          генерация иконок
  make-zip.py            упаковка в zip
  test-parse.js          оффлайн-тесты парсера (26 проверок)
  sign.ps1               подпись в AMO (unlisted)
```

## Сборка и проверка

```powershell
node build/test-parse.js                                   # тесты
npx web-ext lint --source-dir vk-music-downloader          # валидация манифеста
python build/make-zip.py                                   # vk-music-downloader.zip
```

## Установка

Временно: `about:debugging#/runtime/this-firefox` → «Загрузить временное
дополнение» → `vk-music-downloader/manifest.json`.

Постоянно: подписать в AMO как unlisted и открыть полученный `.xpi`:

```powershell
npx web-ext sign --source-dir vk-music-downloader --channel unlisted `
  --api-key=<JWT issuer> --api-secret=<JWT secret>
```

Подробности — в [vk-music-downloader/README.md](vk-music-downloader/README.md).
