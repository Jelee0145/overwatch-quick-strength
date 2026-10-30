"""Website API client and per-user state. Never logs credentials or API bodies."""
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
import json
import math
import hashlib
import uuid
from pathlib import Path
import re
import sqlite3
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import shlex


class UserError(Exception):
    def __init__(self, message, uncertain=False):
        super().__init__(message)
        self.uncertain = uncertain


BIND_ERROR = '绑定错误，请上网页版确认。'


def valid_key(value):
    value = str(value).strip()
    if not re.fullmatch(r'owqs_[a-f0-9]{64}', value):
        raise UserError(BIND_ERROR)
    return value


def credential_scope(key):
    return hashlib.sha256(str(key).encode()).hexdigest()


def battle_tag(value):
    value = unicodedata.normalize("NFC", str(value).strip())
    if len(value.encode("utf-16-le")) > 160 or not re.fullmatch(r"[^\x00-\x1f\x7f]+#[0-9]+", value):
        raise UserError("请填写完整战网昵称（昵称#编号，最长 80 字符）")
    return value


def owner_key(event):
    values = [event.get_platform_id(), event.get_self_id(), event.get_sender_id()]
    if not values[0] or not values[2]:
        raise UserError("无法识别发送者，请检查机器人平台适配器")
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


POOLS = {"5v5": "55", "55": "55", "6v6": "66", "66": "66"}
POOL_LABELS = {"55": "快速 5v5", "66": "快速 6v6", "": "全部快速模式"}


@dataclass(frozen=True)
class Query:
    tag: str
    limit: int = 10
    mode: str = "fast"
    pool: str = ""

    def __post_init__(self):
        object.__setattr__(self, "tag", battle_tag(self.tag))
        if type(self.limit) is not int or self.limit not in (5, 10, 20):
            raise UserError("查询场数只支持 5、10、20")
        if self.mode not in ("fast", "slow"):
            raise UserError("查询模式只支持 fast/slow（快/慢）")
        if self.pool not in ("", "55", "66"):
            raise UserError("对局模式只支持 5v5 / 6v6")

    @property
    def label(self):
        return f"{POOL_LABELS[self.pool]} · {'慢' if self.mode == 'slow' else '快'}模式"


def parse_query(text, binding=None):
    if re.search(r"[\x00-\x1f\x7f]", text):
        raise UserError("查询参数不能包含换行或控制字符")
    parts = text.strip().split()
    limit, mode, pool, seen = 10, "fast", "", set()
    options = ("5", "10", "20", "快", "慢", "fast", "slow", "55", "66", "5v5", "6v6")
    while parts and parts[-1].lower() in options:
        value = parts.pop().lower()
        if value in ("5v5", "55", "6v6", "66"):
            kind = "pool"
        elif value in ("5", "10", "20"):
            kind = "limit"
        else:
            kind = "mode"
        if kind in seen:
            raise UserError("场数、快慢和对局模式各只能填写一次")
        seen.add(kind)
        if kind == "pool":
            pool = POOLS[value]
        elif kind == "limit":
            limit = int(value)
        else:
            mode = "slow" if value in ("慢", "slow") else "fast"
    tag = " ".join(parts) if parts else binding
    if not tag:
        raise UserError("请在查询时填写完整游戏 ID（昵称#编号）；绑定 Key 后可使用上次查询的 ID")
    return Query(tag, limit, mode, pool)


class Bindings:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.db = sqlite3.connect(self.directory / "bindings.sqlite3")
        (self.directory / "bindings.sqlite3").chmod(0o600)
        self.db.execute("CREATE TABLE IF NOT EXISTS bindings(owner TEXT PRIMARY KEY, tag TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS recent(owner TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        self.db.executescript('''CREATE TABLE IF NOT EXISTS api_bindings(owner TEXT PRIMARY KEY, secret TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS last_queries(owner TEXT PRIMARY KEY, scope TEXT NOT NULL, tag TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS free_usage(token TEXT PRIMARY KEY, owner TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS usage_owner_day ON free_usage(owner,day,kind);
        CREATE TABLE IF NOT EXISTS local_reviews(owner TEXT NOT NULL, job TEXT NOT NULL, idx INTEGER NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,job,idx,scope));
        CREATE TABLE IF NOT EXISTS query_requests(owner TEXT PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, request_id TEXT NOT NULL, job TEXT NOT NULL, reservation TEXT, created INTEGER NOT NULL);''')

    def pending_query(self, owner, scope, query):
        fingerprint = hashlib.sha256(json.dumps([query.tag, query.limit, query.mode, query.pool], ensure_ascii=False).encode()).hexdigest()
        row = self.db.execute('SELECT scope,fingerprint,request_id,job,reservation,created FROM query_requests WHERE owner=?', (owner,)).fetchone()
        if row:
            if row[0] != scope or row[1] != fingerprint:
                raise UserError('上次查询结果尚未确认，请先用相同账号和参数重试，避免重复扣费')
            if not row[3] and datetime.now(timezone.utc).timestamp() - row[5] >= 3500:
                raise UserError('上次请求结果不明且已接近任务保留期限，为避免再次扣费已停止重发；请管理员核对网站任务后处理本地待确认记录')
            return {'requestId': row[2], 'job': row[3], 'reservation': row[4]}
        return None

    def start_query(self, owner, scope, query, reservation=None):
        pending = self.pending_query(owner, scope, query)
        if pending:
            return pending
        request_id = getattr(uuid, 'uuid4')().hex
        fingerprint = hashlib.sha256(json.dumps([query.tag, query.limit, query.mode, query.pool], ensure_ascii=False).encode()).hexdigest()
        with self.db:
            self.db.execute('INSERT INTO query_requests VALUES(?,?,?,?,?,?,?)', (owner, scope, fingerprint, request_id, '', reservation, int(datetime.now(timezone.utc).timestamp())))
        return {'requestId': request_id, 'job': '', 'reservation': reservation}

    def query_job(self, owner, request_id, job):
        with self.db:
            self.db.execute('UPDATE query_requests SET job=? WHERE owner=? AND request_id=?', (job, owner, request_id))

    def finish_query(self, owner):
        with self.db:
            self.db.execute('DELETE FROM query_requests WHERE owner=?', (owner,))

    def key(self, owner):
        row=self.db.execute('SELECT secret FROM api_bindings WHERE owner=?',(owner,)).fetchone()
        return row[0] if row else None

    def bind_key(self, owner, key):
        key=valid_key(key)
        with self.db:
            if self.key(owner)!=key:self.clear_context(owner)
            self.db.execute('INSERT OR REPLACE INTO api_bindings VALUES(?,?)',(owner,key))

    def clear_context(self, owner):
        for table in ('recent','last_queries','local_reviews','query_requests'):
            self.db.execute('DELETE FROM '+table+' WHERE owner=?',(owner,))

    def last_tag(self, owner, scope):
        row=self.db.execute('SELECT tag FROM last_queries WHERE owner=? AND scope=?',(owner,scope)).fetchone()
        return row[0] if row else None

    def save_last(self, owner, scope, tag):
        with self.db:self.db.execute('INSERT OR REPLACE INTO last_queries VALUES(?,?,?)',(owner,scope,battle_tag(tag)))

    def reserve(self, owner, kind, limit, now=None):
        if type(limit) is not int or not 0<=limit<=1000:raise UserError('请管理员将免费次数配置为 0—1000 的整数')
        now=now or datetime.now(timezone(timedelta(hours=8)))
        day=now.astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
        token=uuid.uuid4().hex
        with self.db:
            self.db.execute('DELETE FROM free_usage WHERE day<?',(day,))
            count=self.db.execute('SELECT count(*) FROM free_usage WHERE owner=? AND day=? AND kind=?',(owner,day,kind)).fetchone()[0]
            if count>=limit:raise UserError('今日免费'+('锐评' if kind=='review' else '查询')+f'次数已用完（每天 {limit} 次），可绑定网站 Key 使用个人额度')
            self.db.execute('INSERT INTO free_usage VALUES(?,?,?,?)',(token,owner,day,kind))
        return token

    def release(self, token):
        with self.db:self.db.execute('DELETE FROM free_usage WHERE token=?',(token,))

    def cached_review(self, owner, job, index, scope):
        row=self.db.execute('SELECT payload FROM local_reviews WHERE owner=? AND job=? AND idx=? AND scope=?',(owner,job,index,scope)).fetchone()
        return json.loads(row[0]) if row else None

    def cache_review(self, owner, job, index, scope, value):
        with self.db:self.db.execute('INSERT OR REPLACE INTO local_reviews VALUES(?,?,?,?,?)',(owner,job,index,scope,json.dumps(value)))

    def get(self, owner):
        row = self.db.execute("SELECT tag FROM bindings WHERE owner=?", (owner,)).fetchone()
        return row[0] if row else None

    def bind(self, owner, tag):
        tag = battle_tag(tag)
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO bindings VALUES(?,?)", (owner, tag))
        return tag

    def unbind(self, owner):
        with self.db:
            self.db.execute("DELETE FROM bindings WHERE owner=?", (owner,))
            self.db.execute('DELETE FROM api_bindings WHERE owner=?',(owner,))
            self.clear_context(owner)

    def close(self):
        self.db.close()

    def remember(self, owner, result, scope=None):
        job = result.get("id", "")
        matches = (result.get("analysis") or {}).get("matches") or []
        if not re.fullmatch(r"[a-f0-9]{64}", job) or len(matches) > 10:
            raise UserError("网站未返回有效的查询定位信息")
        payload = {"job":job,"matches":[str(m.get("mid", "")) for m in matches],"scope":scope}
        with self.db:
            self.db.execute('DELETE FROM local_reviews WHERE owner=?',(owner,))
            self.db.execute("INSERT OR REPLACE INTO recent VALUES(?,?)",(owner,json.dumps(payload)))

    def selection(self, owner, index, scope=None):
        if type(index) is not int or not 1 <= index <= 10:
            raise UserError("编号只能是图中从左到右的 1—10，例如 /owqs 数据 1")
        row = self.db.execute("SELECT payload FROM recent WHERE owner=?",(owner,)).fetchone()
        if not row:
            raise UserError("请先 /owqs 查询，数据和锐评使用你最近一次查询图的编号")
        value = json.loads(row[0]); count = len(value["matches"])
        if scope is not None and value.get('scope')!=scope:
            raise UserError('绑定或免费服务 Key 已变化，请先重新 /owqs 查询')
        if index > count:
            raise UserError(f"本次图中只有 {count} 场，请选择 1—{count}" if count else "本次查询没有可展示的对局")
        return value["job"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


def event_filters(from_date='', to_date='', region='', tournament='', team='', status='auto', limit=10, series='owcs'):
    values = {'from': from_date, 'to': to_date, 'region': region, 'tournament': tournament, 'team': team}
    for key, value in values.items():
        if not isinstance(value, str) or len(value) > 160 or re.search(r'[\x00-\x1f\x7f]', value):
            raise UserError('赛程筛选条件格式错误')
        values[key] = value.strip()
    for key in ('from', 'to'):
        if values[key]:
            try:
                parsed = datetime.strptime(values[key], '%Y-%m-%d')
                if parsed.strftime('%Y-%m-%d') != values[key]: raise ValueError()
            except ValueError:
                raise UserError('日期请使用有效的 YYYY-MM-DD（北京时间）')
    if values['from'] and values['to'] and values['from'] > values['to']:
        raise UserError('开始日期不能晚于结束日期')
    series={'全部':'all','所有':'all'}.get(str(series).strip().lower(),str(series).strip().lower())
    if series not in ('owcs','all'): raise UserError('赛事范围只支持 OWCS 或 all（全部）')
    if values['from'] and values['to'] and (datetime.strptime(values['to'],'%Y-%m-%d')-datetime.strptime(values['from'],'%Y-%m-%d')).days>365: raise UserError('日期范围最多为 366 天，请分段查询')
    status = {'自动':'auto','赛程': 'scheduled', 'upcoming': 'scheduled', '赛果': 'completed', 'results': 'completed', '全部': 'all'}.get(status, status)
    if status not in ('auto', 'scheduled', 'completed', 'all'):
        raise UserError('状态只支持赛程、赛果、全部')
    if isinstance(limit, bool) or not re.fullmatch(r'[0-9]+(?:\.0+)?', str(limit)) or not 1 <= float(limit) <= 20:
        raise UserError('条数只支持 1—20')
    return {**{k: v for k, v in values.items() if v}, 'status': status, 'limit': int(float(limit)), 'series':series}


def parse_events(text):
    names = {'范围':'series','赛事范围':'series','开始': 'from_date', '结束': 'to_date', '赛区': 'region', '赛事': 'tournament', '战队': 'team', '状态': 'status', '条数': 'limit', 'from': 'from_date', 'to': 'to_date'}
    try: parts = shlex.split(text)
    except ValueError: raise UserError('含空格的筛选值请用成对双引号包住')
    values = {}
    for part in parts:
        if '=' not in part: raise UserError('用法：/owqs 赛程 赛区=中国 战队="All Gamers" 状态=赛程')
        key, value = part.split('=', 1); key = names.get(key, key)
        if key not in ('from_date', 'to_date', 'region', 'tournament', 'team', 'status', 'limit', 'series') or key in values:
            raise UserError('未知或重复的赛程筛选条件')
        values[key] = value
    event_filters(**values)
    return values


def format_events(value):
    def clean(text, limit=80): return re.sub(r'[\r\n]+', ' ', str(text or '')).strip()[:limit]
    def when(text):
        try: return datetime.fromisoformat(text.replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%m-%d %H:%M')
        except (ValueError, TypeError, AttributeError): return '待定'
    scope='OWCS' if value.get('series',value.get('filters',{}).get('series','owcs'))=='owcs' else '全部赛事'
    if value.get('state')=='pending': return scope+' · 服务器正在补查所选日期的数据，稍后再查即可复用结果；尚不能判断有无比赛。'
    lines = [scope+' 赛程与赛果 · 北京时间', ('日期补查缓存' if value.get('range') else '服务器按赛事状态动态同步') + ' · 更新于 ' + when(value.get('updatedAt'))]
    if value.get('range'): lines.append(value['range']['from']+' 至 '+value['range']['to']+'（含首尾日期）')
    if value.get('truncated'): lines.append(value.get('coverage') or '结果可能不完整，请缩小日期范围。')
    if value.get('refreshError'): lines.append(clean(value['refreshError'],160))
    if value.get('stale'): lines.append('更新尚未完成，以下为上次同步数据。')
    matches = value.get('matches') or []
    if not matches: lines.append('没有符合条件的近期比赛。')
    for index, match in enumerate(matches[:20], 1):
        teams = match.get('teams') or [{}, {}]; scores = match.get('scores') or [None, None]
        score = ' : '.join(map(str, scores)) if len(scores) == 2 and all(s is not None for s in scores) else 'VS'
        state = '已结束' if match.get('status') == 'completed' else '赛程／状态以赛事公布为准'
        lines.append(f"{index}. {when(match.get('startsAt'))} {clean(teams[0].get('name'),32)} {score} {clean(teams[1].get('name'),32)}")
        lines.append(f"{clean(match.get('region'),12)} · {clean(match.get('tournament'))}" + (f" · BO{match['bestOf']}" if match.get('bestOf') else '') + ' · ' + state)
    total = value.get('total', len(matches))
    lines.append(f'共 {total} 场，展示 {len(matches)} 场；可按日期、赛区、赛事、战队继续筛选。')
    lines.append('来源：Liquipedia · 仅包含来源已公布的数据，不保证实时比分。')
    return '\n'.join(lines)


class JsonTransport:
    """Bounded HTTPS JSON transport shared by binding and all API operations."""
    def __init__(self, base_url, api_key, request_timeout=15, sync_history=True):
        self.base = str(base_url).strip().rstrip("/")
        self.key = str(api_key).strip()
        self.request_timeout = request_timeout
        self.opener = urllib.request.build_opener(NoRedirect())
        self.sync_history = sync_history

    def validate(self):
        try:
            url = urllib.parse.urlsplit(self.base)
            valid = url.scheme == "https" and url.hostname and not url.username and not url.password and url.path in ("", "/") and not url.query and not url.fragment
            _ = url.port
        except ValueError:
            valid = False
        if not valid:
            raise UserError("请管理员配置正确的 HTTPS 网站地址（包含端口，不包含 /api 路径）")
        valid_key(self.key)

    def _request(self, method, route, body=None):
        self.validate()
        request = urllib.request.Request(self.base + route, method=method, headers={
            "Authorization": "Bearer " + self.key, "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {})
        }, data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.opener.open(request, timeout=self.request_timeout) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise UserError("网站返回的数据过大，请联系管理员", uncertain=True)
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError()
                return value
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise UserError(BIND_ERROR) from None
            if route.startswith('/api/v1/events/tracking/') and error.code == 429:
                failure = UserError('赛事跟踪繁忙，请稍后再试')
                try:
                    failure.retry_after = min(3600, max(1, int(error.headers.get('Retry-After', '60'))))
                except (ValueError, TypeError, AttributeError):
                    failure.retry_after = 60
                raise failure from None
            if route.startswith("/api/v1/events") and error.code==429: raise UserError("赛事补查队列繁忙，请稍后再试") from None
            if route.startswith("/api/v1/events") and error.code==400: raise UserError("赛事筛选条件无效，请检查日期和赛事范围") from None
            if error.code == 429:
                raise UserError("网站额度或未完成任务已达上限，请稍后再试") from None
            if error.code == 404:
                raise UserError("查询记录不存在或已过期，请先重新 /owqs 查询") from None
            if error.code == 400:
                raise UserError("本场数据不足或参数无效，请检查图中的编号；缺少本人战斗数据时无法锐评") from None
            if error.code == 409:
                raise UserError("网站已有任务进行中或查询尚未完成，请稍后再试") from None
            if 300 <= error.code < 400:
                raise UserError("网站返回了重定向，已拒绝转发 API 密钥；请配置最终 HTTPS 地址") from None
            raise UserError(f"网站接口暂不可用（HTTP {error.code}）", uncertain=error.code>=500) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise UserError("网站连接失败或超时；未自动重复创建查询，请稍后再试", uncertain=True) from None
        except (ValueError, UnicodeError):
            raise UserError("网站返回格式异常，请管理员检查 API 地址", uncertain=True) from None

    async def request(self, method, route, body=None):
        return await asyncio.to_thread(self._request, method, route, body)


class ApiClient(JsonTransport):
    async def create(self, query, request_id=None):
        value = await self.request("POST", "/api/v1/query", {
            "requestId": request_id or getattr(uuid, 'uuid4')().hex,
            "battletag": query.tag, "limit": query.limit, "mode": query.mode, "pool": query.pool,
            "statisticsRange": "10", "side": "all", "strategy": "legacy", "estimate": True,
            "syncHistory": self.sync_history,
        })
        job = value.get("id")
        if not isinstance(job, str) or not re.fullmatch(r"[a-f0-9]{64}", job):
            raise UserError("网站没有返回有效任务 ID，未自动重试", uncertain=True)
        return job

    async def account(self):
        return await self.request('GET','/api/v1/account')

    async def active_jobs(self):
        return await self.request('GET', '/api/v1/jobs')

    async def history_analysis(self, battletag, options=None):
        if not self.sync_history:
            raise UserError('免费服务账号不支持云端历史分析')
        return await self.request('POST', '/api/v1/history/analysis', {'battletag': battle_tag(battletag), 'options': options or {}})

    async def historical_match(self, battletag, mid, revision, options=None):
        if not self.sync_history:
            raise UserError('免费服务账号不支持云端历史对局')
        return await self.request('POST', '/api/v1/matches/detail', {'battletag': battle_tag(battletag), 'mid': mid, 'revision': revision, 'options': options or {}})

    async def historical_review(self, battletag, mid, revision, request_id, options=None):
        if not self.sync_history:
            raise UserError('免费服务账号不支持云端历史锐评')
        return await self.request('POST', '/api/v1/matches/review', {'battletag': battle_tag(battletag), 'mid': mid, 'revision': revision, 'options': options or {}, 'requestId': request_id})

    async def wait_review(self, value, timeout=90, poll_interval=1.5):
        """Only poll an acknowledged job; never repeat a mutation after uncertainty."""
        if value.get('cached'):
            return value
        review_id = value.get('id')
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            try:
                value = await self.review_status(review_id)
            except UserError as error:
                error.uncertain = True
                raise
            if value.get('state') == 'done':
                return value
            if value.get('state') in ('failed', 'cancelled'):
                raise UserError('锐评生成失败，网站 AI 额度已释放，请稍后手动重试')
            if asyncio.get_running_loop().time() >= deadline:
                raise UserError('锐评仍在生成，请稍后再试；不会自动重复发起 AI 请求', uncertain=True)
            await asyncio.sleep(poll_interval)

    async def events(self, **filters):
        values = event_filters(**filters)
        route='/api/v1/events?' + urllib.parse.urlencode(values)
        waited=0
        for _ in range(5):
            result=await self.request('GET',route)
            if result.get('state')!='pending' and not result.get('updating'): return result
            delay=max(1,int(result.get('retryAfter',5)))
            if waited+delay>45: return result
            await asyncio.sleep(delay);waited+=delay
        return result

    async def track_events(self, match_ids):
        return await self.request('POST', '/api/v1/events/tracking/sync', {'matchIds': match_ids})

    async def status(self, job):
        return await self.request("GET", "/api/v1/jobs/" + job + "?render=svg&compact=1")

    async def cancel(self, job):
        return await self.request("POST", "/api/v1/jobs/" + job + "/cancel", {})

    async def match(self, job, index):
        return await self.request("GET", f"/api/v1/jobs/{job}/matches/{index}")

    async def review(self, job, index, request_id):
        return await self.request("POST", f"/api/v1/jobs/{job}/matches/{index}/review", {"requestId":request_id})

    async def review_status(self, job):
        if not isinstance(job,str) or not re.fullmatch(r"[a-f0-9]{64}",job):
            raise UserError("网站没有返回有效的锐评任务 ID")
        return await self.request("GET", "/api/v1/reviews/" + job)


@dataclass
class Job:
    owner: str
    query: Query
    id: str = ""
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    client: object = field(default=None, repr=False)


class QueryManager:
    def __init__(self, client, timeout=600, poll_interval=1.5, max_pending=5, store=None):
        self.client = client
        self.store = store
        self.timeout = max(1, float(timeout))
        self.poll_interval = max(0.01, float(poll_interval))
        self.max_pending = max(1, min(5, int(max_pending)))
        self.active = {}
        self.semaphore = asyncio.Semaphore(min(3, self.max_pending))
        self.closed = False

    async def query(self, owner, query, client=None, request_id=None, job_id='', on_created=None):
        client=client or self.client
        client.validate()
        if self.store:
            scope = ('bound:' if client.sync_history else 'free:') + credential_scope(client.key)
            pending = self.store.pending_query(owner, scope, query)
            if pending:
                request_id, job_id = pending['requestId'], pending['job']
                on_created = lambda job: self.store.query_job(owner, request_id, job)
        if self.closed:
            raise UserError("插件正在重载，请稍后再试")
        if owner in self.active:
            raise UserError("你已有排队或运行中的查询，请等待完成或 /owqs 取消")
        if len(self.active) >= self.max_pending:
            raise UserError("插件查询队列已满，请稍后再试")
        job = Job(owner, query, client=client)
        self.active[owner] = job
        terminal = False
        try:
            async with self.semaphore:
                if job.cancelled.is_set():
                    raise UserError("查询已取消")
                deadline = asyncio.get_running_loop().time() + self.timeout
                job.id = job_id or (await client.create(query, request_id=request_id) if request_id else await client.create(query))
                if on_created:
                    on_created(job.id)
                while asyncio.get_running_loop().time() < deadline:
                    if job.cancelled.is_set():
                        raise UserError("查询已取消")
                    result = await client.status(job.id)
                    state = result.get("state")
                    if state == "done":
                        terminal = True
                        if not isinstance(result.get("analysis"), dict):
                            raise UserError("查询已完成，但网站分析生成失败，请在网页中查看原始结果", uncertain=True)
                        return result
                    if state in ("failed", "cancelled"):
                        terminal = True
                        if state=='failed' and result.get('message')=='未找到可查询玩家':
                            raise UserError('未找到这个游戏 ID，请核对完整昵称#编号及大小写，并确认大神能查询该玩家；本次额度已释放。不要直接重复相同查询。')
                        raise UserError("查询已取消" if state == "cancelled" else "网站查询失败，额度已释放，请稍后重试")
                    if state not in ("running", "paused", "awaiting-cache"):
                        raise UserError("网站返回了未知任务状态", uncertain=True)
                    try:
                        await asyncio.wait_for(job.cancelled.wait(), timeout=min(self.poll_interval, max(0.01, deadline - asyncio.get_running_loop().time())))
                    except asyncio.TimeoutError:
                        pass
                raise UserError("查询等待超时，已请求网站取消任务", uncertain=True)
        except UserError as error:
            if job.id and not terminal:error.uncertain=True
            raise
        finally:
            if job.id and not terminal:
                try:
                    await asyncio.shield(client.cancel(job.id))
                except Exception:
                    pass
            if self.active.get(owner) is job:
                self.active.pop(owner, None)

    async def cancel(self, owner):
        job = self.active.get(owner)
        if not job:
            return False
        job.cancelled.set()
        if job.id:
            await job.client.cancel(job.id)
        return True

    async def close(self):
        self.closed = True
        await asyncio.gather(*(self.cancel(owner) for owner in list(self.active)), return_exceptions=True)


def compact_result(result, query):
    analysis = result.get("analysis") or {}
    selected = (analysis.get("personalPrediction") or {}).get("selected") or {}
    summary = analysis.get("summary") or {}
    matches = analysis.get("matches") or []
    # Tools receive bounded summaries, never full rosters, signed archives or credentials.
    return {
        "battletag": query.tag, "mode": query.mode, "pool": query.pool, "searchLimit": query.limit,
        "statisticsLabel": analysis.get("statisticsLabel"),
        "summary": {k: summary.get(k) for k in ("mean", "observedMean", "confidencePercent", "known", "total", "estimated")},
        "prediction": {k: selected.get(k) for k in ("rank", "confidence", "games", "mean", "range", "reasons")},
        "matches": [{k: m.get(k) for k in ("mid", "t", "ret", "mapName", "gameModeLabel", "mean", "observedMean")} for m in matches[-10:]],
        "note": "规则评分参考，不代表实际快速 MMR；不可据此推断官方隐藏分。",
    }


def format_result(result, query):
    value = compact_result(result, query)
    summary, prediction, matches = value["summary"], value["prediction"], value["matches"]
    score = lambda x: str(round(x)) if type(x) in (int, float) and math.isfinite(x) else "暂无"
    lines = [f"狸狸天眼查 · {query.tag}", f"搜索最近 {query.limit} 场 · {query.label}",
             f"分析最近 {len(matches)} 场 · {sum(m.get('ret') == 1 for m in matches)} 胜 / {sum(m.get('ret') == -1 for m in matches)} 负",
             "对局强度均值：" + score(summary.get("mean")),
             "证据可信度：" + score(summary.get("confidencePercent")) + "%"]
    if prediction.get("rank"):
        lines.append(f"个人段位参考：{prediction['rank']}（{prediction.get('confidence') or '未知'}可信度，{prediction.get('games') or 0} 场）")
    if matches:
        lines.append("近期对局（新 → 旧，北京时间）：")
    for match in reversed(matches):
        try:
            # Website analysis timestamps use Unix milliseconds, as the browser chart does.
            when = datetime.fromtimestamp(float(match.get("t")) / 1000, timezone(timedelta(hours=8))).strftime("%m-%d %H:%M")
        except (ValueError, TypeError, OSError, OverflowError):
            when = "时间未知"
        outcome = {1: "胜", -1: "负", 0: "平/未知"}.get(match.get("ret"), "未知")
        map_name = str(match.get("mapName") or "快速对局").replace("\n", " ")[:40]
        mode = str(match.get("gameModeLabel") or "").replace("\n", " ")[:12]
        lines.append(f"{when} {outcome} · {map_name}{' · ' + mode if mode else ''} · 强度 {score(match.get('mean'))}")
    lines.append(value["note"])
    return "\n".join(lines)
