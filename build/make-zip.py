import os
import zipfile

ROOT = 'vk-music-downloader'
OUT = 'vk-music-downloader.zip'

SKIP = {'.DS_Store', 'Thumbs.db'}

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in sorted(dirs) if not d.startswith('.')]
        for name in sorted(files):
            if name in SKIP or name.startswith('.'):
                continue
            full = os.path.join(base, name)
            arc = os.path.relpath(full, ROOT).replace(os.sep, '/')
            zf.write(full, arc)

with zipfile.ZipFile(OUT) as zf:
    bad = [i.filename for i in zf.infolist() if '\\' in i.filename]
    print('entries:', len(zf.infolist()), 'backslash paths:', len(bad))
    for i in zf.infolist():
        print(f'{i.file_size:>7}  {i.filename}')
print('size KB:', round(os.path.getsize(OUT) / 1024, 1))
