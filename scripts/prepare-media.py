"""Run manually to acquire verified map images. CI uses committed, optimized media."""
import concurrent.futures
import hashlib
import io
import json
import subprocess
import urllib.request
from pathlib import Path
from PIL import Image, ImageOps

BASE = Path(__file__).resolve().parent.parent
DEST = BASE / 'source/media'
CACHE = BASE / '.private/media-originals'
DEST.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
maps = json.loads((BASE / 'source/data/maps.json').read_text(encoding='utf-8'))

def derivative(data, edge, quality):
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        image = ImageOps.exif_transpose(image)
        image = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
        image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        image.save(out, format='WEBP', quality=quality, method=6)
        result = out.getvalue()
        with Image.open(io.BytesIO(result)) as check:
            check.verify()
        return result

def save(data, folder, edge, quality):
    encoded = derivative(data, edge, quality)
    digest = hashlib.sha256(encoded).hexdigest()[:20]
    target = DEST / folder / (digest + '.webp')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encoded)
    return '/media/' + folder + '/' + target.name

def acquire(url):
    cached = CACHE / (hashlib.sha256(url.encode()).hexdigest() + '.img')
    legacy = BASE / 'source/assets/maps' / cached.name
    try:
        data = cached.read_bytes() if cached.exists() else legacy.read_bytes() if legacy.exists() else None
        if data is None:
            if not url.startswith(('https://img.166.net/', 'https://d15f34w2p8l1cc.cloudfront.net/')):
                raise ValueError('unapproved image host')
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=25) as response:
                data = response.read(30_000_001)
            if len(data) > 30_000_000:
                raise ValueError('image too large')
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        cached.write_bytes(data)
        return {'preview': save(data, 'maps', 960, 78), 'export': save(data, 'maps', 1920, 86)}
    except Exception as exc:
        return {'error': type(exc).__name__}

sources = {m['guid']: m['icon'] or next((other['icon'] for other in maps if other['name'] == m['name'] and other['icon']), '') for m in maps}
urls = list(dict.fromkeys(sources.values()))
images = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    jobs = {pool.submit(acquire, url): url for url in urls}
    for i, future in enumerate(concurrent.futures.as_completed(jobs), 1):
        images[jobs[future]] = future.result()
        if i % 10 == 0 or i == len(urls):
            print(f'Verified map sources {i}/{len(urls)}', flush=True)

# Extract only the small avatar and official ranks from the old bundle once.
old = BASE / 'source/art.js'
if not old.exists():
    old = BASE / '.private/speed-baseline/public/art.js'
if old.exists():
    script = "const fs=require('fs'),vm=require('vm');let c={window:{}};vm.createContext(c);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);console.log(JSON.stringify({avatar:c.window.QS_AVATAR,ranks:c.window.QS_RANK_ART}));"
    seed = json.loads(subprocess.check_output(['node', '-e', script, str(old)], encoding='utf-8'))
    import base64
    avatar = save(base64.b64decode(seed['avatar'].split(',', 1)[1]), 'icons', 128, 86)
    ranks = {str(key): save(base64.b64decode(value.split(',', 1)[1]), 'icons', 192, 86) for key, value in enumerate(seed['ranks'])}
else:
    previous = json.loads((DEST / 'manifest.json').read_text(encoding='utf-8'))
    avatar, ranks = previous['avatar'], previous['ranks']

manifest = {'version': 1, 'avatar': avatar, 'ranks': ranks, 'maps': {}}
coverage = {'records': len(maps), 'uniqueSources': len(urls), 'missing': [], 'maps': []}
for m in maps:
    source = sources[m['guid']]
    item = images[source]
    if 'error' in item:
        coverage['missing'].append({'guid': m['guid'], 'name': m['name'], 'source': source, 'error': item['error']})
        manifest['maps'][m['guid']] = {'preview': None, 'export': None, 'name': m['name']}
    else:
        manifest['maps'][m['guid']] = {**item, 'name': m['name']}
        coverage['maps'].append({'guid': m['guid'], 'name': m['name'], 'source': source, 'sameNameAlias': source != m['icon'], **item})
for name, value in [('manifest.json', manifest), ('coverage.json', coverage)]:
    (DEST / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(json.dumps({'covered': len(coverage['maps']), 'missing': coverage['missing']}, ensure_ascii=True), flush=True)
