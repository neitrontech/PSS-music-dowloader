from PIL import Image, ImageDraw

def make(size, out):
    s = size * 4
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))

    grad = Image.new('RGBA', (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / max(1, s - 1)
        r = int(96 + (37 - 96) * t)
        g = int(165 + (99 - 165) * t)
        b = int(250 + (235 - 250) * t)
        gd.line([(0, y), (s, y)], fill=(r, g, b, 255))

    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    # головка ноты
    d.ellipse([0.26 * s, 0.585 * s, 0.50 * s, 0.715 * s], fill=white)
    # стебель
    d.rounded_rectangle([0.455 * s, 0.235 * s, 0.525 * s, 0.665 * s], radius=0.035 * s, fill=white)
    # флажок
    d.polygon([
        (0.525 * s, 0.235 * s),
        (0.735 * s, 0.345 * s),
        (0.735 * s, 0.475 * s),
        (0.525 * s, 0.365 * s),
    ], fill=white)

    img.resize((size, size), Image.LANCZOS).save(out)

for px, name in ((48, 'icon-48.png'), (96, 'icon-96.png'), (128, 'icon-128.png')):
    make(px, 'vk-music-downloader/icons/' + name)
print('icons ok')
