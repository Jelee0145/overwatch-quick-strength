import asyncio
from pathlib import Path
import time

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

from .owqs import (JobQueue, NodeBackend, Renderer, Store, UserError, battle_tag,
                   cache_scope, credentials_from, owner_key, parse_query)


HELP = """狸狸天眼查
/owqs 绑定 昵称#编号
/owqs 解绑
/owqs 查询 [昵称#编号] [5|10|20] [快|慢] [5v5|6v6]
/owqs 取消
默认查 10 场、快模式；不填昵称时使用绑定。
图片展示并统计最近 10 场；选择 20 场扩大查询范围。
绑定在同一机器人的群聊与私聊间共用。"""


class Main(Star):
    def __init__(self, context: Context, config):
        super().__init__(context)
        self.config = config
        self.directory = Path(get_astrbot_data_path()) / "plugin_data" / "astrbot_plugin_owqs"
        self.store = Store(self.directory)
        self.backend = NodeBackend(Path(__file__).parent, str(config.get("node_path", "node")))
        self.renderer = Renderer(self.directory, str(config.get("font_family", "Noto Sans CJK SC")))
        self.queue = JobQueue(self.execute, max(1, int(config.get("query_timeout", 600))))
        self.ready = False
        self.start_lock = asyncio.Lock()
        self.cleanup_task = None

    async def initialize(self):
        try:
            await self.ensure_ready()
        except UserError as error:
            # Dependency errors contain no user/configuration values.
            logger.warning("OWQS: %s", error)
        self.cleanup_task = asyncio.create_task(self.cleanup_images())

    async def cleanup_images(self):
        while True:
            await asyncio.sleep(3600)
            self.renderer.cleanup()

    async def ensure_ready(self):
        async with self.start_lock:
            if not self.ready:
                await self.backend.check()
                await self.renderer.check()
                self.ready = True

    async def execute(self, job):
        scope = cache_scope(job.credentials)
        prior = self.store.cached(scope, job.query.tag)
        result = await self.backend.query(job.query, job.credentials, prior, job.events.put)
        image = await self.renderer.render(result["svg"])
        self.store.save(scope, job.query.tag, result["cache"])
        return image

    @filter.command("owqs")
    async def owqs(self, event: AstrMessageEvent):
        """绑定战网昵称、查询快速对局并回复强度图。"""
        event.should_call_llm(False)
        job = None
        try:
            owner = owner_key(event)
            # AstrBot removes the configured wake prefix before command filtering.
            text = event.get_message_str().strip()
            parts = text.split(maxsplit=1)
            arguments = parts[1] if len(parts) > 1 else ""
            parts = arguments.split(maxsplit=1)
            action = parts[0] if parts else ""
            tail = parts[1] if len(parts) > 1 else ""
            if action in ("", "帮助"):
                yield event.plain_result(HELP)
            elif action == "绑定":
                tag = battle_tag(tail)
                self.store.bind(owner, tag)
                yield event.plain_result("已绑定 " + tag)
            elif action == "解绑" and not tail.strip():
                self.store.unbind(owner)
                yield event.plain_result("已解除战网昵称绑定")
            elif action == "取消" and not tail.strip():
                cancelled = await self.queue.cancel(owner)
                yield event.plain_result("已取消查询" if cancelled else "你没有排队或运行中的查询")
            elif action == "查询":
                query = parse_query(tail, self.store.binding(owner))
                credentials = credentials_from(self.config)
                await self.ensure_ready()
                job, position = self.queue.submit(owner, query, credentials)
                yield event.plain_result(f"已接收查询：{query.tag} · {query.limit} 场 · {query.label}" + (f"，前面有 {position} 个任务" if position else ""))
                last_progress = time.monotonic()
                while True:
                    message = await job.events.get()
                    kind = message["type"]
                    if kind == "finished":
                        break
                    if kind == "image":
                        yield event.image_result(message["path"])
                    elif kind == "error":
                        yield event.plain_result(message["message"])
                    elif kind == "paused":
                        yield event.plain_result("大神接口限流，30 秒后继续查询；可 /owqs 取消")
                        last_progress = time.monotonic()
                    elif kind == "started" and position:
                        yield event.plain_result("排队结束，开始查询")
                    elif kind == "progress" and time.monotonic() - last_progress >= 30:
                        yield event.plain_result(f"{message['phaseLabel']} {message['completed']}/{message['total']}")
                        last_progress = time.monotonic()
            else:
                yield event.plain_result(HELP)
        except UserError as error:
            yield event.plain_result(str(error))
        except Exception:
            yield event.plain_result("插件运行失败，请管理员检查运行环境")
        finally:
            # A disconnected/cancelled message handler must not leave an orphan job.
            if job and not job.done.is_set():
                await self.queue.cancel(job.owner)

    async def terminate(self):
        if self.cleanup_task:
            self.cleanup_task.cancel()
            await asyncio.gather(self.cleanup_task, return_exceptions=True)
        await self.queue.close()
        await self.backend.close()
        await self.renderer.close()
        self.store.close()
