"""Refresh public community reference data; never uses account credentials.

Run manually with Python. A failed fetch/parse leaves the existing snapshot intact.
The values are rounded public per-10-minute averages, not player percentiles.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import html
import json
import re
import urllib.request

ROOT = Path(__file__).resolve().parent
BASE = 'https://www.counterwatch.gg/stats/overwatch/heroes/'
NAMES = dict(zip(
    '死神 猎空 天使 半藏 托比昂 莱因哈特 法老之鹰 温斯顿 黑百合 堡垒 秩序之光 禅雅塔 源氏 路霸 卡西迪 狂鼠 查莉娅 士兵：76 卢西奥 D.Va 美 黑影 末日铁拳 安娜 奥丽莎 布丽吉塔 莫伊拉 破坏球 索杰恩 艾什 回声 巴蒂斯特 雾子 渣客女王 西格玛 拉玛刹 生命之梭 毛加 伊拉锐 探奇 骇灾 朱诺 弗蕾娅 无漾 安燃 埃姆雷 金驭 瑞稀 飞天猫 斩仇 西拉 死怨 血律 D.Mon'.split(),
    'reaper tracer mercy hanzo torbjorn reinhardt pharah winston widowmaker bastion symmetra zenyatta genji roadhog cassidy junkrat zarya soldier76 lucio dva mei sombra doomfist ana orisa brigitte moira wrecking-ball sojourn ashe echo baptiste kiriko junker-queen sigma ramattra lifeweaver mauga illari venture hazard juno freja wuyang anran emre domina mizuki jetpackcat vendetta sierra shion doctrine dmon'.split(), strict=True))
KEYS = {'Kills': 'kill', 'Deaths': 'death', 'Assists': 'assist',
        'Damage': 'heroDamage', 'Healing': 'cure', 'Mitigation': 'resistDamage'}

def fetch(hero):
    slug = NAMES[hero['name']]
    url = BASE + slug
    request = urllib.request.Request(url, headers={'User-Agent': 'QuickStrength/2.2 public benchmark refresh'})
    source = urllib.request.urlopen(request, timeout=30).read().decode('utf-8')
    section = source.split('Stats per 10 minutes', 1)[1].split('</ul>', 1)[0]
    stats, role_stats = {}, {}
    for row in re.findall(r'<li\b[^>]*>(.*?)</li>', section, flags=re.S):
        text = html.unescape(re.sub(r'<[^>]*>', ' ', row))
        cells = text.split()
        if len(cells) == 3 and cells[0] in KEYS:
            stats[KEYS[cells[0]]] = float(cells[1].replace(',', ''))
            role_stats[KEYS[cells[0]]] = float(cells[2].replace(',', ''))
    assert all(k in stats for k in ('kill', 'death', 'assist', 'heroDamage')), url
    role = re.search(r'vs\s+(tank|damage|support)\s+avg', re.sub(r'<[^>]*>', ' ', section))
    assert role, url
    role = {'tank': 'tank', 'damage': 'dps', 'support': 'healer'}[role[1]]
    assert role == hero['roleType'], f'Role mismatch: {url}'
    text = html.unescape(re.sub(r'<[^>]*>', ' ', source))
    samples = re.search(r'across\s+([\d,]+)\s+community-tracked matches', text)
    updated = re.search(r'last updated\s+([A-Z][a-z]+\s+\d+,\s+\d{4})', text)
    assert samples and updated, url
    return hero['heroGuid'], {'name': hero['name'], 'role': role, 'slug': slug,
        'per10': stats, 'source': url, 'matches': int(samples[1].replace(',', '')),
        'sourceUpdated': updated[1]}, role_stats

def main():
    heroes = json.loads((ROOT / 'data/heroes.json').read_text(encoding='utf-8'))
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(fetch, heroes))
    role_rows = {}
    for _, row, reference in rows:
        # Median of the source's role-average displays handles rounded snapshot drift.
        for key, value in reference.items():
            role_rows.setdefault(row['role'], {}).setdefault(key, []).append(value)
    import statistics
    roles = {role: {key: statistics.median(values) for key, values in metrics.items()}
             for role, metrics in role_rows.items()}
    result = {'version': 'counterwatch-' + datetime.now(timezone.utc).date().isoformat(),
        'retrievedAt': datetime.now(timezone.utc).isoformat(), 'source': 'Counterwatch',
        'scope': '5V5 / All Ranks / 网站默认筛选；并非国服快速专属或按段位分层样本',
        'units': 'per10minutes', 'heroes': {guid: row for guid, row, _ in rows}, 'roles': roles}
    content = json.dumps(result, ensure_ascii=False, indent=2)
    (ROOT / 'data/performance-benchmarks.json').write_text(content + '\n', encoding='utf-8')
    (ROOT / 'benchmarks.js').write_text('globalThis.QS_BENCHMARKS = ' + content + ';\n', encoding='utf-8')
    print(f'Public benchmark snapshot verified: {len(rows)} heroes, {len(roles)} roles')

if __name__ == '__main__':
    main()
