"""Run manually after replacing a home cover design. CI uses committed, optimized covers.

    uv venv --python 3.15 .venv
    uv pip install --python .venv/Scripts/python.exe pillow
    .venv/Scripts/python.exe scripts/prepare-covers.py

Sources and the committed WebP derivatives live in web/covers; the toolkit build verifies
and copies the derivatives into /media/covers/.
"""
import hashlib
import io
import json
from pathlib import Path
from PIL import Image, ImageOps

BASE = Path(__file__).resolve().parent.parent
SOURCE = BASE / 'web' / 'covers'
EDGE = 1200
QUALITY = 88
# The card art box is 285px tall and roughly 330-390px wide; 4:3 keeps headroom for cropping.
RATIO = 4 / 3
# Vertical crop anchor per cover; higher values keep more of the bottom (trophy, podium).
ANCHOR = {'analysis': 0.5, 'draw': 0.5, 'events': 0.74}

manifest = {}
for cover in sorted(SOURCE.glob('*-cover.png')):
    name = cover.name[:-len('-cover.png')]
    with Image.open(cover) as image:
        image.load()
        image = ImageOps.exif_transpose(image).convert('RGB')
        width, height = image.size
        if width / height > RATIO:
            crop_width = round(height * RATIO)
            left = (width - crop_width) // 2
            image = image.crop((left, 0, left + crop_width, height))
        else:
            crop_height = round(width / RATIO)
            top = round((height - crop_height) * ANCHOR.get(name, 0.5))
            image = image.crop((0, top, width, top + crop_height))
        image = image.resize((EDGE, round(EDGE / RATIO)), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format='WEBP', quality=QUALITY, method=6)
        data = buffer.getvalue()
    with Image.open(io.BytesIO(data)) as check:
        check.verify()
    digest = hashlib.sha256(data).hexdigest()
    for stale in SOURCE.glob(f'{name}.*.webp'):
        stale.unlink()
    target = SOURCE / f'{name}.{digest[:16]}.webp'
    target.write_bytes(data)
    manifest[name] = {'source': f'web/covers/{cover.name}', 'sha256': hashlib.sha256(cover.read_bytes()).hexdigest(), 'image': f'/media/covers/{target.name}'}
    print(f'{name}: {len(data) // 1024} KB -> {target.relative_to(BASE)}')

(SOURCE / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
