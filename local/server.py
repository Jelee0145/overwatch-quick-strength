"""Local-only quick-strength service; Python 3.10+, no third-party packages."""
from __future__ import annotations
import argparse
import copy
import datetime as dt
import http.server
import json
from pathlib import Path
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from credentials import CredentialStore, StoreError
from map_assets import fetch_maps
from match_data import player_data, match_data, merge_data
from recent_history import supplement
import query_cache
from ai_review import ReviewService, ReviewError
from match_data import number
from rank_format import rank_strength

ROOT = Path(__file__).resolve().parent
API = 'https://datamsapi.ds.163.com/v1/a19ld5tool'
PRIVATE = ROOT / '.private'
STORE = CredentialStore(PRIVATE)
JOBS = {}
MATCH_CACHE = {}
MATCH_LOCK = threading.Lock()
AUTH_STATE = {'state': 'unchecked', 'message': '尚未检测'}
LOCK = threading.Lock()
HEROES = {str(h['heroGuid']): h.get('roleType') for h in json.loads((ROOT / 'data/heroes.json').read_text(encoding='utf-8-sig'))}
AI_REVIEWS = ReviewService(PRIVATE,
    {str(h['heroGuid']): h for h in json.loads((ROOT / 'data/heroes.json').read_text(encoding='utf-8-sig'))},
    {str(m['guid']): m for m in json.loads((ROOT / 'data/maps.json').read_text(encoding='utf-8-sig'))})

class QueryError(Exception):
    pass

class AuthError(QueryError):
    pass

class Cancelled(QueryError):
    pass

def unwrap(data):
    for _ in range(3):
        if isinstance(data, dict) and 'data' in data and not any(k in data for k in ('guideCountData', 'teammateList', 'matchId')):
            data = data['data']
        else:
            break
    return data

def rank_valid(value, name='', division=None):
    return rank_strength(value, name, division) is not None

def rank_rows(data, season=''):
    data = unwrap(data)
    if not isinstance(data, dict):
        raise QueryError('竞技统计返回结构异常')
    rows = data.get('guideCountData', [])
    if not isinstance(rows, list):
        raise QueryError('竞技职责列表格式异常')
    return [{'r': r.get('roleType', ''), 's': (r.get('lastRankInfo') or {}).get('rankScore', 0), 'n': (r.get('lastRankInfo') or {}).get('rankName', ''), 'd': (r.get('lastRankInfo') or {}).get('rankSubTier'), 'season': season} for r in rows]

class Client:
    def __init__(self, config, job):
        self.config, self.job, self.last = config, job, 0
        self.headers = {'Accept': 'application/json', 'GL-Bigdata-Role-Id': config['roleId'], 'GL-Bigdata-Auth-Token': config['token'], 'GL-Bigdata-Dts': config['dts'], 'GL-Bigdata-Server': config['server'], 'GL-ClientType': '60', 'Origin': 'https://act.ds.163.com', 'Referer': 'https://act.ds.163.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) app/df_client dfVersion/100111'}

    def check(self):
        if self.job['cancel'].is_set():
            raise Cancelled('查询已停止；保留原图表')

    def wait(self, seconds):
        if self.job['cancel'].wait(max(0, seconds)):
            self.check()

    def call(self, path, params=None, body=None):
        for attempt in range(3):
            self.check()
            self.wait(1.0 - (time.monotonic() - self.last))
            url = API + path
            if params is not None:
                url += '?' + urllib.parse.urlencode({k:v for k,v in params.items() if v is not None and v != ''})
            headers = dict(self.headers)
            encoded = None
            if body is not None:
                encoded = json.dumps(body).encode('utf-8')
                headers['Content-Type'] = 'application/json;charset=UTF-8'
            req = urllib.request.Request(url, data=encoded, headers=headers)
            self.last = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=25) as response:
                    payload = json.load(response)
                self.check()
                if not isinstance(payload, dict):
                    raise QueryError('上游返回非 JSON 对象')
                code = payload.get('code')
                if code in (401, 403):
                    raise AuthError('大神凭据无效或已过期，请重新获取后查询')
                if code == 429:
                    if attempt < 2:
                        self.wait(3 * (attempt + 1))
                        continue
                    raise QueryError('大神接口限流，稍后重试')
                if code not in (0, 200) or payload.get('success') is False:
                    raise QueryError('大神接口返回业务错误（错误码 ' + str(code)[:20] + '）')
                return unwrap(payload.get('data'))
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403):
                    raise AuthError('大神凭据无效或已过期，请重新获取后查询') from None
                if exc.code in (429, 502, 503, 504) and attempt < 2:
                    self.wait(3 * (attempt + 1))
                    continue
                raise QueryError('大神请求失败（HTTP ' + str(exc.code) + '）') from None
            except (urllib.error.URLError, TimeoutError):
                if attempt < 2:
                    self.wait(2 * (attempt + 1))
                    continue
                raise QueryError('大神请求超时或网络不可用') from None
            except json.JSONDecodeError:
                raise QueryError('大神请求超时、网络不可用或返回格式异常') from None

def pool_size(mode):
    mode = str(mode or '')
    match = re.fullmatch(r'(?i)leisure(\d+)v(\d+)', mode)
    if match:
        return max(int(match.group(1)), int(match.group(2)))
    return 5 if mode.lower().startswith('leisure') else None


def in_pool(match, pool):
    """5v5 and 6v6 quick play are one upstream list; keep only the chosen size."""
    wanted = {'55': 5, '66': 6}.get(pool or '')
    if not wanted:
        return True
    size = pool_size(match.get('gameMode'))
    return size == wanted


def collect(config, job, client_factory=Client, cache_root=None):
    private = cache_root if cache_root is not None else PRIVATE
    previous = query_cache.load(private, config)
    cached = {m['mid']: m for m in previous['matches']}
    for m in cached.values():
        m['dataQueriedAt'] = m.get('dataQueriedAt') or previous.get('queriedAt', '')
        for p in m['players']:
            p['res']['rankQueriedAt'] = p['res'].get('rankQueriedAt') or m['dataQueriedAt']
    client = client_factory(config, job)
    job['message'] = '正在解析战网昵称…'
    account = client.call('/searchBnetAccount', body={'name': config['battletag'], 'token': config['token'], 'roleId': config['roleId'], 'dts': config['dts'], 'server': config['server']})
    token = account.get('customerToken') if isinstance(account, dict) else None
    if not token:
        raise QueryError('未找到该玩家，或大神未返回可查询账号')
    listed = {}
    for page in range(1, 6):
        result = client.call('/customer/queryMatchList', {'token': token, 'gameMode': 'leisure', 'page': page, 'season': ''})
        if isinstance(result, dict): result = result.get('matchList', result.get('recentMatchList'))
        if not isinstance(result, list):
            raise QueryError('快速对局列表返回结构异常')
        for match in result:
            mid = str(match.get('matchId') or '')[:100]
            if mid and mid not in listed:
                listed[mid] = {'matchId': mid, 'beginTs': number(match.get('beginTs')) or 0,
                               'matchRet': match.get('matchRet', 0), 'mapGuid': str(match.get('mapGuid', ''))[:80],
                               'gameMode': str(match.get('gameMode', ''))[:40]}
        if sum(1 for m in listed.values() if in_pool(m, config.get('pool', ''))) >= config['limit'] or not result:
            break
    candidates = {mid: {'matchId': mid, 'beginTs': m['t'], 'matchRet': m['ret'], 'mapGuid': m['mapGuid'],
                        'gameMode': m.get('gameMode', '')}
                  for mid, m in cached.items() if query_cache.usable(m, config['battletag'])}
    candidates.update(listed)
    selected = sorted((m for m in candidates.values() if in_pool(m, config.get('pool', ''))),
                      key=lambda m: m['beginTs'], reverse=True)[:config['limit']]
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()
    now_ts = time.time()
    rank_cache = {}
    for m in cached.values():
        for p in m['players']:
            res = p['res']
            try:
                age = now_ts - dt.datetime.fromisoformat(res['rankQueriedAt']).timestamp()
            except (ValueError, TypeError, KeyError):
                continue
            if not res.get('error') and 0 <= age < 21600:
                old = rank_cache.get(p['name'])
                if old is None or res['rankQueriedAt'] > old['rankQueriedAt']:
                    rank_cache[p['name']] = res
    out, wanted, names = [], {}, {}
    fetched = reused = rank_fetches = rank_reuses = 0
    for index, match in enumerate(selected):
        if job['cancel'].is_set():
            raise Cancelled('查询已停止，原图表已保留')
        mid = match['matchId']
        saved = cached.get(mid)
        consistent = saved and (not match['mapGuid'] or match['mapGuid'] == saved['mapGuid']) and (not match['beginTs'] or match['beginTs'] == saved['t'])
        if consistent and query_cache.usable(saved, config['battletag']) and saved.get('resourceDataChecked'):
            m = copy.deepcopy(saved)
            m['ret'] = match['matchRet'] if match['matchRet'] in (-1, 0, 1) else m['ret']
            if match.get('gameMode'): m['gameMode'] = match['gameMode']
            out.append(m)
            reused += 1
            job['message'] = f'复用已获取对局 {reused} 场 · 新读取 {fetched} 场…'
            continue
        job['message'] = f'读取新对局 {index + 1}/{len(selected)} · 已复用 {reused} 场…'
        detail = client.call('/customer/queryMatchInfo', {'token': token, 'matchId': mid, 'season': ''})
        if not isinstance(detail, dict) or not any(k in detail for k in ('teammateList', 'enemyList')):
            raise QueryError('对局详情返回结构异常')
        players = []
        for key, side in (('teammateList', 'T'), ('enemyList', 'E')):
            for p in detail.get(key) or []:
                ct = p.get('customerToken')
                public = player_data(p, side)
                if ct:
                    wanted.setdefault(ct, public['name'])
                    names[public['name']] = ct
                players.append({**public, '_token': ct})
        metadata = match_data(detail)
        out.append({'mid': mid, 't': match['beginTs'], 'ret': match['matchRet'], 'mapGuid': match['mapGuid'],
                    'gameMode': match.get('gameMode', ''),
                    'players': players, 'hasGameData': True, 'dataQueriedAt': now,
                    **{k: metadata[k] for k in ('duration', 'teamScore', 'opponentScore', 'resourceDataChecked')}})
        fetched += 1
    stats = {}
    for index, (ct, name) in enumerate(wanted.items()):
        if job['cancel'].is_set():
            raise Cancelled('查询已停止，原图表已保留')
        if name in rank_cache:
            stats[ct] = copy.deepcopy(rank_cache[name])
            rank_reuses += 1
            continue
        job['message'] = f'读取新增玩家段位 {index + 1}/{len(wanted)} · 对局复用 {reused} 场…'
        stat = {'rows': [], 'previousRows': [], 'rankQueriedAt': now}
        try:
            stat['rows'] = rank_rows(client.call('/customer/queryCountInfo', {'token': ct, 'gameMode': 'sport', 'season': ''}))
        except AuthError:
            raise
        except QueryError as exc:
            if isinstance(exc, Cancelled):
                raise
            stat['error'] = True
        stats[ct] = stat
        if not stat.get('error'):
            rank_cache[name] = stat
        rank_fetches += 1
    for match in out:
        for player in match['players']:
            if '_token' in player:
                ct = player.pop('_token')
                player['res'] = stats.get(ct, {'rows': [], 'error': True, 'rankQueriedAt': now})
            elif player['name'] in names and names[player['name']] in stats:
                # A newly fetched rank may update the same player in reused games.
                player['res'] = copy.deepcopy(stats[names[player['name']]])
    result = {'schemaVersion': 1, 'battletag': config['battletag'], 'source': '网易大神 · 增量查询' if listed else '网易大神 · 已有缓存记录',
              'queriedAt': now, 'cacheScope': query_cache.scope(config),
              'used_previous_season_fallback': any(p['res'].get('previousRows') for m in out for p in m['players']),
              'matches': out, 'recentHistory': copy.deepcopy([h for h in previous.get('recentHistory', []) if h['name'] != config['battletag']]),
              'syncStatus': {'fetchedMatches': fetched, 'reusedMatches': reused, 'totalMatches': len(out),
                             'listedMatches': len(listed), 'rankFetches': rank_fetches, 'rankReuses': rank_reuses,
                             'cachedOnly': not bool(listed)}}
    if config.get('recentHistory') and (fetched or not result['recentHistory']):
        supplement(config, job, result, client, private / 'recent-history.json', rank_rows, QueryError, AuthError, Cancelled, names, stats)
    elif previous.get('historyStatus'):
        history = result['recentHistory']
        result['historyStatus'] = {**previous['historyStatus'], 'requests': 0, 'cacheHits': len(history),
                                  'sampledPlayers': len(history), 'playersWithGames': sum(bool(h['matches']) for h in history),
                                  'games': len({m['mid'] for h in history for m in h['matches']})}
        result['historyQueriedAt'] = previous.get('historyQueriedAt', '')
    return result

def worker(config, job):
    try:
        job['result'] = collect(config, job)
        if job['cancel'].is_set():
            raise Cancelled('查询已停止，原图表已保留')
        query_cache.save(PRIVATE, config, job['result'])
        PRIVATE.mkdir(parents=True, exist_ok=True)
        temp = PRIVATE / 'latest.tmp'
        temp.write_text(json.dumps(job['result'], ensure_ascii=False), encoding='utf-8')
        temp.replace(PRIVATE / 'latest.json')
        AUTH_STATE.update(state='valid', message='最近查询鉴权成功')
        job['state'] = 'done'
        sync = job['result']['syncStatus']
        job['message'] = f'完成 {sync["totalMatches"]} 场 · 新读取 {sync["fetchedMatches"]} 场 · 自动复用 {sync["reusedMatches"]} 场'
        if sync['cachedOnly']:
            job['message'] = '上游暂无新的对局列表 · ' + job['message']
    except Cancelled as exc:
        job.update(state='cancelled', message=str(exc))
    except AuthError as exc:
        AUTH_STATE.update(state='expired', message=str(exc))
        job.update(state='failed', message=str(exc))
    except QueryError as exc:
        job.update(state='failed', message=str(exc))
    except Exception:
        job.update(state='failed', message='查询遇到未识别的返回结构，原图表已保留')
    finally:
        config.clear()

def validate(body):
    if body.get('useSaved'):
        body = {**body, **STORE.load()}
    config = {key: str(body.get(key, '')).strip() for key in ('battletag', 'roleId', 'token', 'dts', 'server')}
    if '#' not in config['battletag'] or len(config['battletag']) > 80:
        raise QueryError('请输入完整战网昵称')
    if not config['roleId'].isdigit() or not config['token'] or len(config['token']) > 4096:
        raise QueryError('请填写有效 Role ID 和 Token')
    if not config['dts'].isdigit() or not config['server'].isdigit():
        raise QueryError('Dts 和 Server 必须为数字')
    try:
        config['limit'] = max(1, min(20, int(body.get('limit', 10))))
    except (ValueError, TypeError):
        raise QueryError('场数格式错误') from None
    config['recentHistory'] = body.get('recentHistory') is True
    config['pool'] = body.get('pool') if body.get('pool') in ('55', '66') else ''
    return config

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass  # Never log URLs, request bodies or credentials.

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def respond(self, value, code=200):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json;charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def local(self):
        return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}' and self.headers.get('Origin') in (None, f'http://127.0.0.1:{self.server.server_port}')

    def do_GET(self):
        if not self.local():
            return self.respond({'error': '只接受本机工具请求'}, 403)
        if self.path == '/api/credentials':
            try: return self.respond({**STORE.status(), **AUTH_STATE})
            except StoreError as exc: return self.respond({'error': str(exc)}, 400)
        if self.path == '/api/ai-key':
            try: return self.respond(AI_REVIEWS.keys.status())
            except StoreError as exc: return self.respond({'error': str(exc)}, 400)
        if self.path == '/api/latest':
            path = PRIVATE / 'latest.json'
            try: result = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
            except (ValueError, OSError): result = None
            return self.respond({'result': result, 'activeJob': next((k for k,j in JOBS.items() if j['state']=='running'), None)})
        if self.path == '/api/health':
            return self.respond({'ok': True, 'service': 'quick-strength', 'version': 2})
        if self.path.startswith('/api/job/'):
            job = JOBS.get(self.path.split('/')[-1])
            return self.respond({k: v for k, v in job.items() if k != 'cancel'} if job else {'error': '查询任务不存在'}, 200 if job else 404)
        public = {'index.html','style.css','core.js','chart.js','app.js','ai-review.js','data.js','art.js','favicon.ico','browser-token.js','benchmarks.js','performance.js','rating-rules.js','resource-rating.js'}
        target = urllib.parse.urlsplit(self.path).path.lstrip('/') or 'index.html'
        if target not in public: return self.respond({'error': '文件不开放访问'}, 404)
        # Local scripts change together. Do not return a stale conditional 304
        # that can pair an old core with a newly loaded application script.
        if 'If-Modified-Since' in self.headers:
            del self.headers['If-Modified-Since']
        self.path = '/' + target
        super().do_GET()

    def do_HEAD(self):
        # The static server must not serve private files through HEAD either.
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        origin = self.headers.get('Origin')
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}' or origin not in (None, f'http://127.0.0.1:{self.server.server_port}'):
            return self.respond({'error': '只接受本地工具页面的请求'}, 403)
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 20000:
                raise QueryError('请求大小异常')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise QueryError('请求必须为 JSON 对象')
            if self.path == '/api/ai-key/save':
                AI_REVIEWS.keys.save(body.get('key'))
                return self.respond(AI_REVIEWS.keys.status())
            if self.path == '/api/ai-key/clear':
                AI_REVIEWS.keys.clear()
                return self.respond({'configured': False})
            if self.path == '/api/ai-review':
                with LOCK:
                    try: snapshot = json.loads((PRIVATE / 'latest.json').read_text(encoding='utf-8'))
                    except (ValueError, OSError): raise ReviewError('暂无保存的对局，请先查询') from None
                return self.respond(AI_REVIEWS.review(body, snapshot))
            if self.path.startswith('/api/job/') and self.path.endswith('/cancel'):
                job = JOBS.get(self.path.split('/')[-2])
                if not job:
                    return self.respond({'error': '查询任务不存在'}, 404)
                job['cancel'].set()
                return self.respond({'ok': True})
            if self.path == '/api/map-art':
                return self.respond(fetch_maps(body.get('maps')))
            if self.path == '/api/match-data':
                config = validate(body)
                mid = str(body.get('matchId', ''))
                if not mid or len(mid) > 100:
                    raise QueryError('场次编号格式错误')
                cache_key = (config['battletag'], config['server'], config['dts'], mid)
                with MATCH_LOCK:
                    data = MATCH_CACHE.get(cache_key)
                    if data is None:
                        if any(j['state'] == 'running' for j in JOBS.values()):
                            return self.respond({'error': '正在查询战绩，完成后可补齐本场数据'}, 409)
                        client = Client(config, {'cancel': threading.Event()})
                        account = client.call('/searchBnetAccount', body={'name': config['battletag'], **{k: config[k] for k in ('token', 'roleId', 'dts', 'server')}})
                        ct = account.get('customerToken') if isinstance(account, dict) else None
                        if not ct:
                            raise QueryError('未找到该玩家')
                        detail = client.call('/customer/queryMatchInfo', {'token': ct, 'matchId': mid, 'season': ''})
                        if not isinstance(detail, dict) or not any(k in detail for k in ('teammateList', 'enemyList')):
                            raise QueryError('对局详情返回结构异常')
                        data = match_data(detail)
                        data['dataQueriedAt'] = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()
                        MATCH_CACHE[cache_key] = data
                        if len(MATCH_CACHE) > 100:
                            MATCH_CACHE.pop(next(iter(MATCH_CACHE)))
                    path = PRIVATE / 'latest.json'
                    with LOCK:
                        if path.exists():
                            latest = json.loads(path.read_text(encoding='utf-8'))
                            if latest.get('cacheScope') == query_cache.scope(config):
                                for match in latest.get('matches', []):
                                    if str(match.get('mid')) == mid:
                                        merge_data(match, data)
                                        match['dataQueriedAt'] = data.get('dataQueriedAt') or match.get('dataQueriedAt', '')
                                query_cache.save(PRIVATE, config, latest)
                                temp = PRIVATE / 'latest-match.tmp'
                                temp.write_text(json.dumps(latest, ensure_ascii=False), encoding='utf-8')
                                temp.replace(path)
                config.clear()
                return self.respond(data)
            if self.path == '/api/shutdown':
                for job in JOBS.values(): job['cancel'].set()
                self.respond({'ok': True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path == '/api/credentials/clear':
                STORE.clear()
                AUTH_STATE.update(state='unchecked', message='已清除本机凭证')
                return self.respond({'ok': True})
            if self.path in ('/api/credentials/save', '/api/credentials/check'):
                config = validate({**body, 'battletag': body.get('battletag') or 'daze#51307'})
                if self.path.endswith('/save'):
                    STORE.save(config)
                    AUTH_STATE.update(state='unchecked', message='已加密保存，待检测')
                    return self.respond({**STORE.status(), **AUTH_STATE})
                job = {'cancel': threading.Event()}
                account = Client(config, job).call('/searchBnetAccount', body={'name': config['battletag'], **{k: config[k] for k in ('token','roleId','dts','server')}})
                if not isinstance(account, dict) or not account.get('customerToken'): raise QueryError('凭据请求成功，但未找到该玩家；不能确认查询可用')
                AUTH_STATE.update(state='valid', message='凭据有效，可查询')
                return self.respond({**STORE.status(), **AUTH_STATE})
            if self.path != '/api/query':
                return self.respond({'error': '未知接口'}, 404)
            config = validate(body)
            with LOCK:
                if any(j['state'] == 'running' for j in JOBS.values()):
                    return self.respond({'error': '已有查询在进行，请先停止或等待完成'}, 409)
                JOBS.clear()
                key = secrets.token_urlsafe(24)
                job = {'state': 'running', 'message': '准备查询…', 'cancel': threading.Event()}
                JOBS[key] = job
                threading.Thread(target=worker, args=(config, job), daemon=True).start()
            self.respond({'id': key}, 202)
        except ReviewError as exc:
            self.respond({'error': str(exc)}, exc.code)
        except OSError:
            self.respond({'error': '本机文件读写失败，请检查权限后重试'}, 500)
        except AuthError as exc:
            AUTH_STATE.update(state='expired', message=str(exc))
            self.respond({'error': str(exc)}, 401)
        except (ValueError, QueryError, StoreError) as exc:
            self.respond({'error': str(exc) if isinstance(exc, (QueryError, StoreError)) else 'JSON 格式错误'}, 400)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18765)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/api/health', timeout=2) as response:
            existing = json.load(response)
        if existing.get('service') == 'quick-strength':
            if args.open: webbrowser.open(f'http://127.0.0.1:{args.port}')
            return
    except (OSError, ValueError): pass
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    url = f'http://127.0.0.1:{server.server_port}'
    print('Quick Strength: ' + url + '\nClose this window or press Ctrl+C to stop.', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for job in JOBS.values():
            job['cancel'].set()
        server.server_close()

if __name__ == '__main__':
    main()
