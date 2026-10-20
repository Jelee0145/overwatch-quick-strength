"""Bot-independent command, storage, process and scheduling code.

Nothing in this module logs requests, subprocess output or private cache data.
"""
import asyncio
from collections import deque
from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import time
import unicodedata
import uuid


class UserError(Exception):
    """A message safe to show in the conversation."""


def battle_tag(value):
    value = unicodedata.normalize("NFC", value.strip())
    if len(value.encode("utf-16-le")) > 160 or not re.fullmatch(r"[^\x00-\x1f\x7f]+#[0-9]+", value):
        raise UserError("请输入完整战网昵称（昵称#编号，最长 80 字符）")
    return value


def owner_key(event):
    parts = [event.get_platform_id(), event.get_self_id(), event.get_sender_id()]
    if not parts[0] or not parts[2]:
        raise UserError("无法识别当前平台或发送者，请检查 AstrBot 适配器")
    return json.dumps(parts, ensure_ascii=False, separators=(",", ":"))


def credentials_from(config):
    result = {key: str(config.get(key, "")).strip() for key in (
        "DASHEN_SERVER", "DASHEN_DTS", "DASHEN_ROLE_ID", "DASHEN_TOKEN"
    )}
    if not all(result.values()):
        raise UserError("请管理员先在插件配置中填写完整的大神查询凭证")
    return result


def cache_scope(credentials):
    raw = [credentials[key] for key in ("DASHEN_SERVER", "DASHEN_DTS", "DASHEN_ROLE_ID", "DASHEN_TOKEN")]
    return hashlib.sha256(json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class Query:
    tag: str
    limit: int = 10
    mode: str = "fast"


def parse_query(arguments, binding=None):
    # Consume options from the right, so names containing spaces are preserved.
    tokens = arguments.strip().split()
    limit, mode, seen = 10, "fast", set()
    while tokens and tokens[-1] in ("5", "10", "20", "快", "慢"):
        option = tokens.pop()
        kind = "mode" if option in ("快", "慢") else "limit"
        if kind in seen:
            raise UserError("场数和快慢模式各只能填写一次")
        seen.add(kind)
        if kind == "mode":
            mode = "slow" if option == "慢" else "fast"
        else:
            limit = int(option)
    tag = " ".join(tokens) if tokens else binding
    if not tag:
        raise UserError("请先 /owqs 绑定 昵称#编号，或在查询时指定昵称")
    try:
        return Query(battle_tag(tag), limit, mode)
    except UserError:
        raise UserError("查询格式：/owqs 查询 [昵称#编号] [5|10|20] [快|慢]") from None


class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.db = sqlite3.connect(self.directory / "state.sqlite3")
        (self.directory / "state.sqlite3").chmod(0o600)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS bindings(owner TEXT PRIMARY KEY, tag TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cache(
                scope TEXT NOT NULL, tag TEXT NOT NULL, body TEXT NOT NULL, updated REAL NOT NULL,
                PRIMARY KEY(scope, tag));
            PRAGMA user_version=1;
        """)

    def binding(self, owner):
        row = self.db.execute("SELECT tag FROM bindings WHERE owner=?", (owner,)).fetchone()
        return row[0] if row else None

    def bind(self, owner, tag):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO bindings VALUES(?,?)", (owner, battle_tag(tag)))

    def unbind(self, owner):
        with self.db:
            self.db.execute("DELETE FROM bindings WHERE owner=?", (owner,))

    def cached(self, scope, tag):
        row = self.db.execute("SELECT body FROM cache WHERE scope=? AND tag=?", (scope, tag)).fetchone()
        if not row:
            return None
        try:
            value = json.loads(row[0])
            return value if value["scope"] == scope and value["snapshot"]["battletag"] == tag else None
        except (ValueError, KeyError, TypeError):
            return None

    def save(self, scope, tag, value):
        if value.get("scope") != scope or value.get("snapshot", {}).get("battletag") != tag:
            raise UserError("查询缓存范围不一致，未保存本次缓存")
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if len(body.encode()) > 16 * 1024 * 1024:
            raise UserError("查询缓存过大，未保存本次缓存")
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO cache VALUES(?,?,?,?)", (scope, tag, body, time.time()))
            # A small working cache, not a user-visible history archive.
            self.db.execute("DELETE FROM cache WHERE rowid NOT IN (SELECT rowid FROM cache ORDER BY updated DESC LIMIT 30)")

    def close(self):
        self.db.close()


async def stop_process(process):
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


class NodeBackend:
    def __init__(self, plugin_dir, node="node"):
        self.runtime = Path(plugin_dir).resolve() / "runtime.mjs"
        self.node = node
        self.processes = set()

    async def check(self):
        if not self.runtime.is_file():
            raise UserError("缺少 runtime.mjs，请安装已打包的 OWQS 插件 ZIP，源码需先执行 npm run plugin:build")
        if not shutil.which(self.node):
            raise UserError("找不到 Node.js，请安装 Node.js 22+ 并设置插件 node_path")
        try:
            process = await asyncio.create_subprocess_exec(
                self.node, str(self.runtime), "--check", stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
        except OSError:
            raise UserError("无法启动 Node.js，请检查 node_path") from None
        self.processes.add(process)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 10)
            if process.returncode != 0 or b'"type":"ready"' not in output:
                raise UserError("Node 核心检查失败，请确认 Node.js 22+ 和插件素材完整")
        finally:
            await stop_process(process)
            self.processes.discard(process)

    async def query(self, request, credentials, prior, progress):
        try:
            process = await asyncio.create_subprocess_exec(
                self.node, str(self.runtime), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                limit=64 * 1024 * 1024)
        except OSError:
            raise UserError("无法启动 Node.js，请管理员检查运行依赖") from None
        self.processes.add(process)
        try:
            payload = {"version": 1, "credentials": credentials,
                       "request": {"tag": request.tag, "limit": request.limit, "mode": request.mode}, "prior": prior}
            process.stdin.write(json.dumps(payload, ensure_ascii=False).encode())
            await process.stdin.drain()
            process.stdin.close()
            result = None
            async for line in process.stdout:
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeError):
                    raise UserError("查询核心返回格式异常，请管理员重新安装插件") from None
                kind = value.get("type")
                if kind in ("progress", "paused"):
                    await progress(value)
                elif kind == "error":
                    raise UserError(value.get("message", "查询失败"))
                elif kind == "done":
                    result = value
            await process.wait()
            if process.returncode or not result:
                raise UserError("查询核心意外退出，请管理员检查运行环境")
            return result
        except (BrokenPipeError, ConnectionResetError):
            raise UserError("查询核心意外退出，请管理员检查运行环境") from None
        finally:
            await stop_process(process)
            self.processes.discard(process)

    async def close(self):
        await asyncio.gather(*(stop_process(p) for p in tuple(self.processes)))


class Renderer:
    def __init__(self, directory, font_family="Noto Sans CJK SC"):
        self.directory = Path(directory).resolve() / "images"
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.font_family = font_family
        self.playwright = self.browser = None
        self.cleanup()

    def cleanup(self):
        for image in self.directory.glob("*.png"):
            if re.fullmatch(r"[a-f0-9]{32}\.png", image.name) and not image.is_symlink():
                if image.resolve().parent == self.directory and image.stat().st_mtime < time.time() - 86400:
                    image.unlink()

    async def check(self):
        if self.browser and self.browser.is_connected():
            return
        await self.close()
        try:
            from playwright.async_api import async_playwright
            self.playwright = await async_playwright().start()
            self.browser = await self.playwright.chromium.launch()
        except asyncio.CancelledError:
            await self.close()
            raise
        except Exception:
            await self.close()
            raise UserError("无法启动出图浏览器，请安装插件依赖并执行 python -m playwright install --with-deps chromium") from None

    async def render(self, svg):
        await self.check()
        self.cleanup()
        page = await self.browser.new_page(device_scale_factor=1)
        target = self.directory / (uuid.uuid4().hex + ".png")
        try:
            # All assets are embedded; never allow the renderer to make network requests.
            await page.route("**/*", lambda route: route.abort())
            await page.set_content('<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>' + svg)
            await page.locator("svg").evaluate("(svg, font) => { svg.style.fontFamily = font + ', sans-serif'; }", self.font_family)
            await page.evaluate("async () => { await document.fonts.ready; await Promise.all([...document.querySelectorAll('svg image')].map(el => new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = reject; img.src = el.getAttribute('href'); }))); }")
            await page.locator("svg").screenshot(path=str(target), timeout=30000)
            target.chmod(0o600)
            return str(target)
        except asyncio.CancelledError:
            target.unlink(missing_ok=True)
            raise
        except Exception:
            target.unlink(missing_ok=True)
            raise UserError("图片生成失败，请管理员检查 Chromium、中文字体和插件素材") from None
        finally:
            await page.close()

    async def close(self):
        try:
            if self.browser:
                await self.browser.close()
        finally:
            self.browser = None
            if self.playwright:
                await self.playwright.stop()
                self.playwright = None


@dataclass
class Job:
    owner: str
    query: Query
    credentials: dict = field(repr=False)
    events: asyncio.Queue = field(default_factory=asyncio.Queue, repr=False)
    task: object = field(default=None, repr=False)
    done: asyncio.Event = field(default_factory=asyncio.Event, repr=False)


class JobQueue:
    """One execution lane, five waiters, and one job per Bot user."""
    def __init__(self, execute, timeout=600):
        self.execute, self.timeout = execute, timeout
        self.waiting, self.owners = deque(), {}
        self.wake = asyncio.Event()
        self.worker = self.current = None
        self.closed = False

    def submit(self, owner, query, credentials):
        if self.closed:
            raise UserError("插件正在重载，请稍后重试")
        if owner in self.owners:
            raise UserError("你已有排队或运行中的查询，请等待完成或 /owqs 取消")
        if len(self.owners) >= 6:
            raise UserError("查询队列已满（最多等待 5 个），请稍后重试")
        position = len(self.waiting) if self.current else max(0, len(self.waiting) - 1)
        job = Job(owner, query, credentials.copy())
        self.owners[owner] = job
        self.waiting.append(job)
        if self.worker is None:
            self.worker = asyncio.create_task(self._work())
        self.wake.set()
        # Number ahead includes the currently running (or first scheduled) task.
        return job, position + (1 if self.current or len(self.waiting) > 1 else 0)

    async def _finish(self, job, event):
        await job.events.put(event)
        await job.events.put({"type": "finished"})
        self.owners.pop(job.owner, None)
        job.done.set()

    async def _work(self):
        while not self.closed:
            if not self.waiting:
                self.wake.clear()
                await self.wake.wait()
                continue
            job = self.current = self.waiting.popleft()
            try:
                await job.events.put({"type": "started"})
                job.task = asyncio.create_task(self.execute(job))
                result = await asyncio.wait_for(job.task, self.timeout)
                await self._finish(job, {"type": "image", "path": result})
            except asyncio.TimeoutError:
                await self._finish(job, {"type": "error", "message": "查询运行超时，已取消；可以稍后重新查询"})
            except asyncio.CancelledError:
                await self._finish(job, {"type": "cancelled"})
                if self.closed:
                    return
            except UserError as error:
                await self._finish(job, {"type": "error", "message": str(error)})
            except Exception:
                await self._finish(job, {"type": "error", "message": "插件运行失败，请管理员检查运行环境"})
            finally:
                self.current = None

    async def cancel(self, owner):
        job = self.owners.get(owner)
        if not job:
            return False
        if job in self.waiting:
            self.waiting.remove(job)
            await self._finish(job, {"type": "cancelled"})
        elif job.task:
            job.task.cancel()
            await job.done.wait()
        return True

    async def close(self):
        self.closed = True
        for job in tuple(self.waiting):
            self.waiting.remove(job)
            await self._finish(job, {"type": "cancelled"})
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
