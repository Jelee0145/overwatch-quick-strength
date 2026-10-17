"""Website API client and per-user state. Never logs credentials or API bodies."""
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
import json
import math
from pathlib import Path
import re
import sqlite3
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


class UserError(Exception):
    pass


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


@dataclass(frozen=True)
class Query:
    tag: str
    limit: int = 10
    mode: str = "fast"

    def __post_init__(self):
        object.__setattr__(self, "tag", battle_tag(self.tag))
        if type(self.limit) is not int or self.limit not in (5, 10, 20):
            raise UserError("查询场数只支持 5、10、20")
        if self.mode not in ("fast", "slow"):
            raise UserError("查询模式只支持 fast/slow（快/慢）")


def parse_query(text, binding=None):
    if re.search(r"[\x00-\x1f\x7f]", text):
        raise UserError("查询参数不能包含换行或控制字符")
    parts = text.strip().split()
    limit, mode, seen = 10, "fast", set()
    while parts and parts[-1] in ("5", "10", "20", "快", "慢", "fast", "slow"):
        value = parts.pop()
        kind = "limit" if value in ("5", "10", "20") else "mode"
        if kind in seen:
            raise UserError("场数和模式各只能填写一次")
        seen.add(kind)
        if kind == "limit":
            limit = int(value)
        else:
            mode = "slow" if value in ("慢", "slow") else "fast"
    tag = " ".join(parts) if parts else binding
    if not tag:
        raise UserError("请先 /owqs 绑定 昵称#编号，或在查询时填写完整昵称")
    return Query(tag, limit, mode)


class Bindings:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.db = sqlite3.connect(self.directory / "bindings.sqlite3")
        (self.directory / "bindings.sqlite3").chmod(0o600)
        self.db.execute("CREATE TABLE IF NOT EXISTS bindings(owner TEXT PRIMARY KEY, tag TEXT NOT NULL)")

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

    def close(self):
        self.db.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


class ApiClient:
    def __init__(self, base_url, api_key, request_timeout=15):
        self.base = str(base_url).strip().rstrip("/")
        self.key = str(api_key).strip()
        self.request_timeout = request_timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def validate(self):
        try:
            url = urllib.parse.urlsplit(self.base)
            valid = url.scheme == "https" and url.hostname and not url.username and not url.password and url.path in ("", "/") and not url.query and not url.fragment
            _ = url.port
        except ValueError:
            valid = False
        if not valid:
            raise UserError("请管理员配置正确的 HTTPS 网站地址（包含端口，不包含 /api 路径）")
        if not re.fullmatch(r"owqs_[a-f0-9]{64}", self.key):
            raise UserError("请管理员在插件配置中填写网站账户的 API 密钥")

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
                    raise UserError("网站返回的数据过大，请联系管理员")
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError()
                return value
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise UserError("网站 API 密钥无效或所属账号未授权，请管理员检查插件配置") from None
            if error.code == 429:
                raise UserError("网站额度或未完成任务已达上限，请稍后再试") from None
            if 300 <= error.code < 400:
                raise UserError("网站返回了重定向，已拒绝转发 API 密钥；请配置最终 HTTPS 地址") from None
            raise UserError(f"网站接口暂不可用（HTTP {error.code}）") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise UserError("网站连接失败或超时；未自动重复创建查询，请稍后再试") from None
        except (ValueError, UnicodeError):
            raise UserError("网站返回格式异常，请管理员检查 API 地址") from None

    async def request(self, method, route, body=None):
        return await asyncio.to_thread(self._request, method, route, body)

    async def create(self, query):
        value = await self.request("POST", "/api/v1/query", {
            "battletag": query.tag, "limit": query.limit, "mode": query.mode,
            "statisticsRange": "10", "side": "all", "strategy": "legacy", "estimate": True,
        })
        job = value.get("id")
        if not isinstance(job, str) or not re.fullmatch(r"[a-f0-9]{64}", job):
            raise UserError("网站没有返回有效任务 ID，未自动重试")
        return job

    async def status(self, job):
        return await self.request("GET", "/api/v1/jobs/" + job)

    async def cancel(self, job):
        return await self.request("POST", "/api/v1/jobs/" + job + "/cancel", {})


@dataclass
class Job:
    owner: str
    query: Query
    id: str = ""
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)


class QueryManager:
    def __init__(self, client, timeout=600, poll_interval=1.5, max_pending=5):
        self.client = client
        self.timeout = max(1, float(timeout))
        self.poll_interval = max(0.01, float(poll_interval))
        self.max_pending = max(1, min(5, int(max_pending)))
        self.active = {}
        self.semaphore = asyncio.Semaphore(min(3, self.max_pending))
        self.closed = False

    async def query(self, owner, query):
        self.client.validate()
        if self.closed:
            raise UserError("插件正在重载，请稍后再试")
        if owner in self.active:
            raise UserError("你已有排队或运行中的查询，请等待完成或 /owqs 取消")
        if len(self.active) >= self.max_pending:
            raise UserError("插件查询队列已满，请稍后再试")
        job = Job(owner, query)
        self.active[owner] = job
        terminal = False
        try:
            async with self.semaphore:
                if job.cancelled.is_set():
                    raise UserError("查询已取消")
                deadline = asyncio.get_running_loop().time() + self.timeout
                job.id = await self.client.create(query)
                while asyncio.get_running_loop().time() < deadline:
                    if job.cancelled.is_set():
                        raise UserError("查询已取消")
                    result = await self.client.status(job.id)
                    state = result.get("state")
                    if state == "done":
                        terminal = True
                        if not isinstance(result.get("analysis"), dict):
                            raise UserError("查询已完成，但网站分析生成失败，请在网页中查看原始结果")
                        return result
                    if state in ("failed", "cancelled"):
                        terminal = True
                        raise UserError("查询已取消" if state == "cancelled" else "网站查询失败，额度已释放，请稍后重试")
                    if state not in ("running", "paused", "awaiting-cache"):
                        raise UserError("网站返回了未知任务状态")
                    try:
                        await asyncio.wait_for(job.cancelled.wait(), timeout=min(self.poll_interval, max(0.01, deadline - asyncio.get_running_loop().time())))
                    except asyncio.TimeoutError:
                        pass
                raise UserError("查询等待超时，已请求网站取消任务")
        finally:
            if job.id and not terminal:
                try:
                    await asyncio.shield(self.client.cancel(job.id))
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
            await self.client.cancel(job.id)
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
        "battletag": query.tag, "mode": query.mode, "searchLimit": query.limit,
        "statisticsLabel": analysis.get("statisticsLabel"),
        "summary": {k: summary.get(k) for k in ("mean", "observedMean", "confidencePercent", "known", "total", "estimated")},
        "prediction": {k: selected.get(k) for k in ("rank", "confidence", "games", "mean", "range", "reasons")},
        "matches": [{k: m.get(k) for k in ("mid", "t", "ret", "mapName", "mean", "observedMean")} for m in matches[-10:]],
        "note": "规则评分参考，不代表实际快速 MMR；不可据此推断官方隐藏分。",
    }


def format_result(result, query):
    value = compact_result(result, query)
    summary, prediction, matches = value["summary"], value["prediction"], value["matches"]
    score = lambda x: str(round(x)) if type(x) in (int, float) and math.isfinite(x) else "暂无"
    lines = [f"狸狸天眼查 · {query.tag}", f"搜索最近 {query.limit} 场 · {'慢' if query.mode == 'slow' else '快'}模式",
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
        lines.append(f"{when} {outcome} · {map_name} · 强度 {score(match.get('mean'))}")
    lines.append(value["note"])
    return "\n".join(lines)
