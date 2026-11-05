"""Run manually after the hero roster changes. CI uses the committed WebP files.

Hero table icons are downloaded once from the approved CDNs listed in source/media/hero-icon-sources.json
and served from /media/icons; draw-page portraits are re-encoded from the committed PNG originals.
"""
import hashlib
import io
import json
import urllib.request
from pathlib import Path
from PIL import Image

BASE = Path(__file__).resolve().parent.parent
MEDIA = BASE / 'source/media'
CACHE = BASE / '.private/media-originals'
DRAW = BASE / 'frontend/web/draw'
CACHE.mkdir(parents=True, exist_ok=True)
HOSTS = ('https://img.166.net/', 'https://d15f34w2p8l1cc.cloudfront.net/')

def webp(data, edge, quality):
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        image = image.convert('RGBA')
        image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        image.save(out, format='WEBP', quality=quality, alpha_quality=90, method=6)
        result = out.getvalue()
    with Image.open(io.BytesIO(result)) as check:
        check.verify()
    return result

def acquire(url):
    if not url.startswith(HOSTS):
        raise ValueError('unapproved image host: ' + url)
    cached = CACHE / (hashlib.sha256(url.encode()).hexdigest() + '.img')
    if cached.exists():
        return cached.read_bytes()
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(5_000_001)
    if len(data) > 5_000_000:
        raise ValueError('image too large: ' + url)
    with Image.open(io.BytesIO(data)) as image:
        image.verify()
    cached.write_bytes(data)
    return data

sources = json.loads((MEDIA / 'hero-icon-sources.json').read_text(encoding='utf-8'))
icons = {}
for guid, url in sources.items():
    encoded = webp(acquire(url), 128, 82)
    name = hashlib.sha256(encoded).hexdigest()[:20] + '.webp'
    (MEDIA / 'icons' / name).write_bytes(encoded)
    icons[guid] = '/media/icons/' + name

manifest_path = MEDIA / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['heroIcons'] = icons
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

roster_path = DRAW / 'heroes.json'
roster = json.loads(roster_path.read_text(encoding='utf-8'))
for hero in roster['heroes']:
    original = (DRAW / 'portraits' / hero['file']).read_bytes()
    if hashlib.sha256(original).hexdigest() != hero['sha256']:
        raise ValueError('portrait original changed without updating sha256: ' + hero['id'])
    encoded = webp(original, max(hero['width'], hero['height']), 86)
    (DRAW / 'portraits' / (hero['id'] + '.webp')).write_bytes(encoded)
    hero['webp'] = hero['id'] + '.webp'
    hero['webpSha256'] = hashlib.sha256(encoded).hexdigest()
with open(roster_path, 'w', encoding='utf-8', newline='\r\n') as file:
    file.write(json.dumps(roster, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'heroIcons': len(icons), 'portraits': len(roster['heroes'])}), flush=True)
