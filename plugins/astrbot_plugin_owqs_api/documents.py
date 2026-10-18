"""Escaped HTML templates for offline match-data and AI-review images."""
from datetime import datetime, timedelta, timezone
from html import escape
import math

def text(value, limit=200):
    return escape(str(value if value is not None else '—')[:limit])

def number(value):
    return f'{value:,.0f}' if type(value) in (int,float) and math.isfinite(value) else '—'

STYLE = '''*{box-sizing:border-box}body{margin:0;width:1440px;background:#111923;color:#edf2f7;font:22px "Noto Sans CJK SC",sans-serif}.sheet{width:1440px;padding:38px}header,section{background:#1b2530;border:1px solid #344352;border-radius:18px;padding:26px;margin-bottom:20px}h1{font-size:36px;margin:0 0 12px}h2{font-size:25px;color:#82e4df;margin:12px 0}p{margin:10px 0;line-height:1.7}.muted,footer{color:#a4b4c5;font-size:19px}table{border-collapse:collapse;width:100%;font-size:19px;table-layout:fixed}td,th{padding:14px 8px;border-bottom:1px solid #344352;text-align:right;overflow-wrap:anywhere}th{color:#a4b4c5;font-size:17px}td:first-child,th:first-child{text-align:left;width:185px}td:nth-child(2),th:nth-child(2){width:110px;text-align:left}.subject{color:#82e4df;font-weight:700}.prose{white-space:pre-wrap;overflow-wrap:anywhere;font-size:25px;line-height:1.85}footer{padding:8px 12px}'''

def header(detail,title):
    try:when=datetime.fromtimestamp(float(detail.get('t'))/1000,timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')
    except (ValueError,TypeError,OverflowError,OSError):when='时间未知'
    result={1:'胜利',-1:'失败',0:'平局／未知'}.get(detail.get('ret'),'未知')
    return f'<header><h1>狸狸天眼查 · {title}</h1><p>{text(detail.get("battletag"))} · 图中第 {text(detail.get("index"))} 场／{text(detail.get("count"))} 场</p><p class="muted">{text(detail.get("mapName"))} · {result} · {when}（北京时间） · 时长 {number(detail.get("duration"))} 秒</p></header>'

def sheet(content):
    return '<!doctype html><meta charset="utf-8"><style>'+STYLE+'</style><main class="sheet">'+content+'</main>'

def data_document(detail):
    basic=[('kill','击杀'),('assist','助攻'),('death','死亡'),('heroDamage','伤害'),('cure','治疗'),('resistDamage','抵挡')]
    extra=[('finalHit','最后一击'),('soloKill','单独击杀'),('targetCompetingTime','目标时间／秒'),('healingTaken','受治疗'),('damageTaken','承受伤害')]
    content=header(detail,'单局数据')
    if not detail.get('hasGameData'):content+='<p class="muted">此局缺少部分战斗数据；仅展示已有记录，未返回的值显示 —。</p>'
    for side,label in [('T','我方'),('E','对方')]:
        players=[p for p in detail.get('players',[])[:50] if p.get('side')==side]
        content+='<section><h2>'+label+'</h2>'
        for columns in [basic,extra]:
            content+='<table><thead><tr><th>玩家</th><th>英雄</th>'+''.join('<th>'+label+'</th>' for _,label in columns)+('<th>表现分</th>' if columns is basic else '')+'</tr></thead><tbody>'
            for p in players:
                own=p.get('name')==detail.get('battletag')
                content+='<tr'+(' class="subject"' if own else '')+'><td>'+text(p.get('name'),50)+'</td><td>'+text(p.get('hero'),30)+'</td>'
                content+=''.join('<td>'+number((p.get('stats') or {}).get(key))+'</td>' for key,_ in columns)
                if columns is basic:content+='<td>'+number((p.get('performance') or {}).get('score'))+'</td>'
                content+='</tr>'
            content+='</tbody></table>'
        content+='</section>'
    return sheet(content+'<footer>编号与最近一次查询图从左到右一致。英雄为接口返回值；受治疗未拆分来源，承伤与抵挡不同；— 表示未返回。表现分是规则参考。</footer>')

def review_documents(detail,review):
    body=str(review.get('text') or '')
    if not body.strip():raise ValueError('Empty AI review')
    # Bound each image while preserving every returned character, including line breaks.
    if len(body)>24000:raise ValueError('AI review too large')
    pages=[body[i:i+3000] for i in range(0,len(body),3000)]
    return [sheet(header(detail,'AI 锐评'+(f' · {i+1}/{len(pages)}' if len(pages)>1 else ''))+'<section class="prose">'+escape(page)+'</section><footer>AI 生成内容，仅供娱乐与对局复盘参考；'+('复用已有锐评，不重复消耗 AI 额度。' if review.get('cached') else '消耗网站账号的 AI 锐评额度。')+'</footer>') for i,page in enumerate(pages)]
