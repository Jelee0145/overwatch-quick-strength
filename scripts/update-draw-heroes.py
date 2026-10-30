"""Refresh the official roster; reuse transparent portraits and fetch missing or opaque PNGs.

python -X utf8 scripts/update-draw-heroes.py [--legacy-dir PATH_TO_FOXYARCADE]
Requires Pillow. This maintenance command is never run by the site build or deploy.
"""
import argparse
import hashlib
import html
import io
import json
import re
import shutil
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "frontend" / "web" / "draw" / "portraits"
ROSTER_URL = "https://overwatch.blizzard.com/en-us/heroes/"
NAMES = dict(zip(
    "reaper tracer mercy hanzo torbjorn reinhardt pharah winston widowmaker bastion symmetra zenyatta genji roadhog cassidy junkrat zarya soldier-76 lucio dva mei sombra doomfist ana orisa brigitte moira wrecking-ball sojourn ashe echo baptiste kiriko junker-queen sigma ramattra lifeweaver mauga illari venture hazard juno freja wuyang anran emre domina mizuki jetpack-cat vendetta sierra shion doctrine dmon".split(),
    "死神 猎空 天使 半藏 托比昂 莱因哈特 法老之鹰 温斯顿 黑百合 堡垒 秩序之光 禅雅塔 源氏 路霸 卡西迪 狂鼠 查莉娅 士兵：76 卢西奥 D.Va 美 黑影 末日铁拳 安娜 奥丽莎 布丽吉塔 莫伊拉 破坏球 索杰恩 艾什 回声 巴蒂斯特 雾子 渣客女王 西格玛 拉玛刹 生命之梭 毛加 伊拉锐 探奇 骇灾 朱诺 弗蕾娅 无漾 安燃 埃姆雷 金驭 瑞稀 飞天猫 斩仇 西拉 死怨 血律 D.Mon".split(),
))
LEGACY_NAMES = {"卡西迪": "麦克雷", "士兵：76": "士兵76", "布丽吉塔": "布里吉塔", "生命之梭": "花男", "伊拉锐": "伊拉瑞", "弗蕾娅": "弗雷雅", "埃姆雷": "艾姆雷"}
ROLES = {"tank": "重装", "damage": "输出", "support": "支援"}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-dir", type=Path)
    args = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    old = {}
    if args.legacy_dir:
        code = (args.legacy_dir / "app.js").read_text(encoding="utf-8")
        old = {name: filename for name, filename in re.findall(r'name: "([^"]+)", role: "[^"]+", filename: "([^"]+)"', code)}
    previous_path = DEST.parent / "heroes.json"
    previous = json.loads(previous_path.read_text(encoding="utf-8")) if previous_path.exists() else {"heroes": []}
    existing = {hero["id"]: hero for hero in previous["heroes"]}
    alternate = {hero["name"]: hero.get("smallIconUrl") for hero in json.loads((ROOT / "source/data/heroes.json").read_text(encoding="utf-8"))}
    document = fetch(ROSTER_URL).decode("utf-8")
    cards = re.findall(r'<a class="hero-card"[^>]*>.*?</a>', document)
    heroes, seen, downloaded, imported = [], set(), [], []
    for card in cards:
        slug = re.search(r'\bid="([^"]+)"', card)[1]
        if slug in seen:
            continue
        seen.add(slug)
        if slug not in NAMES:
            raise ValueError(f"New official hero {slug}: add its Chinese display name before updating")
        name = NAMES[slug]
        role = ROLES[re.search(r'data-role="([^"]+)"', card)[1]]
        url = html.unescape(re.search(r'<blz-image class="heroCardPortrait"[^>]*src="([^"]+)"', card)[1])
        filename = existing.get(slug, {}).get("file", old.get(LEGACY_NAMES.get(name, name), slug + ".png"))
        target = DEST / filename
        if not target.exists():
            legacy = args.legacy_dir / "owimg" / filename if args.legacy_dir else None
            if legacy and legacy.exists():
                shutil.copyfile(legacy, target)
                assert hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(legacy.read_bytes()).digest()
                imported.append(name)
            else:
                payload = fetch(url)
                # Validate before writing; opaque replacements are not acceptable portraits.
                image = Image.open(io.BytesIO(payload))
                if image.format != "PNG" or image.convert("RGBA").getchannel("A").getextrema() != (0, 255):
                    raise ValueError(f"Official portrait is not a transparent PNG: {slug}")
                target.write_bytes(payload)
                downloaded.append(name)
        image = Image.open(target)
        transparent = image.convert("RGBA").getchannel("A").getextrema() == (0, 255)
        if not transparent:
            payload = fetch(url)
            replacement = Image.open(io.BytesIO(payload))
            if replacement.format != "PNG" or replacement.convert("RGBA").getchannel("A").getextrema() != (0, 255):
                url = alternate.get(name)
                if not url:
                    raise ValueError(f"No transparent replacement source: {slug}")
                payload = fetch(url)
                replacement = Image.open(io.BytesIO(payload))
                if replacement.format != "PNG" or replacement.convert("RGBA").getchannel("A").getextrema() != (0, 255):
                    raise ValueError(f"Replacement is not transparent: {slug}")
            target.write_bytes(payload)
            image, transparent = replacement, True
            downloaded.append(name)
        heroes.append({"id": slug, "name": name, "role": role, "file": filename,
                       "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "width": image.width, "height": image.height, "transparent": transparent,
                       "source": url if name in downloaded else existing.get(slug, {}).get("source", "FoxyArcade" if name in imported else url)})
    if len(heroes) < 50:
        raise ValueError("Official roster parsing incomplete; refusing to replace hero pool")
    heroes.sort(key=lambda hero: list(NAMES).index(hero["id"]))
    manifest = {"updatedAt": datetime.now(timezone.utc).date().isoformat(), "rosterSource": ROSTER_URL, "heroes": heroes}
    previous_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"heroes": len(heroes), "importedUnchanged": len(imported), "downloaded": downloaded}, ensure_ascii=False))


if __name__ == "__main__":
    main()
