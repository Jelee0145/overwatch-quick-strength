import asyncio
import json
import re
import uuid
from pathlib import Path

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

from .api_client import ApiClient, Bindings, Query, QueryManager, UserError, compact_result, format_result, owner_key, parse_query
from .renderer import Renderer

HELP = """狸狸天眼查 · 网站 API
/owqs 绑定 昵称#编号
/owqs 查询 [昵称#编号] [5|10|20] [快|慢]
/owqs 数据 n
/owqs 锐评 n
/owqs 解绑
/owqs 取消
/owqs 帮助
默认搜索最近 10 场、快模式；不填昵称时使用绑定。
默认发送最近 10 场强度图，出图失败时回复文字摘要。查询消耗插件 API 密钥所属账号的网站额度。
数据／锐评按你最近一次查询图从左到右编号（1—10，不足十场按实际数量）。数据不重新查战绩；锐评使用网站 AI 额度，已有锐评直接复用。
也可直接对 Bot 说“查询 某人#12345 的守望先锋战绩”，由 owqs_query 工具查询。"""


class Main(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        directory = Path(get_astrbot_data_path()) / "plugin_data" / "astrbot_plugin_owqs_api"
        self.bindings = Bindings(directory)
        self.renderer = Renderer(directory)
        self.client = ApiClient(config.get("api_base", ""), config.get("api_key", ""))
        self.manager = QueryManager(self.client, timeout=config.get("query_timeout", 600), max_pending=config.get("max_pending", 5))
        self.review_pending = set()
        self.review_slot = asyncio.Semaphore(1)

    async def selected_images(self, event, n, review=False):
        if isinstance(n,bool) or not re.fullmatch(r"[0-9]{1,2}",str(n)):
            raise UserError("请填写图中从左到右的编号，例如 /owqs 数据 1 或 /owqs 锐评 10")
        n=int(n);owner=owner_key(event);job=self.bindings.selection(owner,n)
        if not review:
            value=await self.client.match(job,n);detail=value.get('match') or {}
            try:return [await self.renderer.render_data(detail)],None
            except Exception:return [],f"第 {n} 场数据图生成失败；地图：{detail.get('mapName','未知')}。请在网站查看完整数据。"
        if owner in self.review_pending:raise UserError("你已有锐评排队或生成中，请等待完成")
        if len(self.review_pending)>=5:raise UserError("锐评队列已满，请稍后再试")
        self.review_pending.add(owner)
        try:
            async with self.review_slot:
                value=await self.client.review(job,n,uuid.uuid4().hex)
                deadline=asyncio.get_running_loop().time()+90
                if not value.get('cached'):
                    review_id=value.get('id')
                    while True:
                        value=await self.client.review_status(review_id)
                        if value.get('state')=='done':break
                        if value.get('state') in ('failed','cancelled'):raise UserError("锐评生成失败，网站 AI 额度已释放，请稍后手动重试")
                        if asyncio.get_running_loop().time()>=deadline:raise UserError("锐评仍在生成，请稍后再试；不会自动重复发起 AI 请求")
                        await asyncio.sleep(1.5)
                detail=value.get('match') or {};report=value.get('review') or {}
                try:return await self.renderer.render_review(detail,report),None
                except Exception:return [],f"第 {n} 场锐评图片生成失败，改用正文：\n"+str(report.get('text') or '网站未返回锐评正文')
        finally:self.review_pending.discard(owner)

    @filter.command("owqs")
    async def owqs(self, event: AstrMessageEvent):
        """绑定战网昵称，通过网站 API 查询守望先锋快速战绩。"""
        event.should_call_llm(False)
        try:
            owner = owner_key(event)
            parts = event.get_message_str().strip().split(maxsplit=1)
            tail = parts[1].split(maxsplit=1) if len(parts) > 1 else []
            action = tail[0] if tail else "帮助"
            arguments = tail[1] if len(tail) > 1 else ""
            if action in ("帮助", "help"):
                yield event.plain_result(HELP)
            elif action == "绑定":
                yield event.plain_result("已绑定 " + self.bindings.bind(owner, arguments))
            elif action == "解绑" and not arguments:
                self.bindings.unbind(owner)
                yield event.plain_result("已解除战网昵称绑定")
            elif action == "取消" and not arguments:
                cancelled = await self.manager.cancel(owner)
                yield event.plain_result("已请求取消查询" if cancelled else "你没有排队或运行中的查询")
            elif action == "查询":
                query = parse_query(arguments, self.bindings.get(owner))
                self.client.validate()
                yield event.plain_result(f"正在通过网站查询 {query.tag}，请稍候；可 /owqs 取消。")
                result = await self.manager.query(owner, query)
                try:
                    image = await self.renderer.render(result.get("chart"))
                    message=event.image_result(image)
                    self.bindings.remember(owner,result)
                    yield message
                except Exception:
                    yield event.plain_result("本次图片生成失败，改用文字结果（不会重复查询）。\n" + format_result(result, query))
            elif action in ('数据','锐评'):
                # Validate the selected window before acknowledging or creating a paid task.
                if not re.fullmatch(r'[0-9]{1,2}',arguments):raise UserError('用法：/owqs '+action+' n，n 为图中从左到右的编号')
                self.bindings.selection(owner,int(arguments))
                yield event.plain_result(f"正在准备第 {int(arguments)} 场{action}图片…")
                images,fallback=await self.selected_images(event,arguments,review=action=='锐评')
                for image in images:yield event.image_result(image)
                if fallback:yield event.plain_result(fallback)
            else:
                yield event.plain_result(HELP)
        except UserError as error:
            yield event.plain_result(str(error))
        except Exception:
            yield event.plain_result("查询插件执行失败，请管理员检查网站连接与插件配置")

    @filter.llm_tool(name="owqs_query")
    async def query_tool(self, event: AstrMessageEvent, battletag: str = "", limit: int = 10, mode: str = "fast") -> str:
        """通过网站 API 查询守望先锋战绩，并直接向当前会话发送最近十场强度图片。成功后无需再次用文字复述整份结果。必须提供完整战网昵称或使用用户绑定，不能编造编号。消耗网站额度，默认快模式，只有用户要求补采时用 slow。规则评分不代表官方 MMR。

        Args:
            battletag(string): 完整战网昵称，如昵称#12345。为空时仅使用当前发送者的已有绑定。
            limit(number): 搜索最近多少场，仅支持 5、10、20，默认 10；分析窗口固定最近 10 场。
            mode(string): fast 为快查询，slow 为补采其他玩家对局的慢查询，默认 fast。
        """
        try:
            owner = owner_key(event)
            tag = battletag.strip() or self.bindings.get(owner)
            if not tag:
                raise UserError("当前用户尚未绑定，请先询问完整战网昵称（昵称#编号）")
            query = Query(tag, limit, mode)
            result = await self.manager.query(owner, query)
            try:
                image = await self.renderer.render(result.get("chart"))
                await event.send(event.image_result(image))
                self.bindings.remember(owner,result)
                return json.dumps({"battletag":query.tag,"imageSent":True,"displayed":len((result.get("analysis") or {}).get("matches") or []),"message":"强度图片已发送，无需重复展示详细文字"},ensure_ascii=False)
            except Exception:
                await event.send(event.plain_result("本次图片生成失败，改用文字结果（不会重复查询）。\n" + format_result(result, query)))
                return json.dumps({"battletag":query.tag,"imageSent":False,"textSent":True,"summary":compact_result(result, query)},ensure_ascii=False)
        except UserError as error:
            return str(error)
        except Exception:
            return "网站战绩查询失败，请联系管理员检查插件配置"

    @filter.llm_tool(name="owqs_bind")
    async def bind_tool(self, event: AstrMessageEvent, battletag: str) -> str:
        """用户明确要求绑定或记住自己的守望先锋战网昵称时使用。只绑定完整昵称，不验证账号所有权，不接受或存储密码。

        Args:
            battletag(string): 用户提供的完整战网昵称，如昵称#12345；不得自行推测编号。
        """
        try:
            return "已绑定 " + self.bindings.bind(owner_key(event), battletag)
        except UserError as error:
            return str(error)

    @filter.llm_tool(name="owqs_match_data")
    async def match_data_tool(self,event: AstrMessageEvent,n:int)->str:
        """发送当前用户最近一次战绩图中第 n 场的真实战斗数据图片。编号从左到右，最多 1—10；必须先查询，不会重新查询战绩。

        Args:
            n(number): 用户指定的图中编号，从左到右 1—10，不得凭空选择对局。
        """
        return await self.send_selected_tool(event,n,False)

    @filter.llm_tool(name="owqs_match_review")
    async def match_review_tool(self,event: AstrMessageEvent,n:int)->str:
        """用户明确要求锐评时，发送其最近一次查询图中第 n 场的 AI 锐评图片。编号从左到右，最多 1—10。会消耗网站 AI 额度，已有相同锐评复用缓存；不要在用户只要数据时调用。

        Args:
            n(number): 用户明确指定的图中编号，从左到右 1—10。
        """
        return await self.send_selected_tool(event,n,True)

    async def send_selected_tool(self,event,n,review):
        try:
            images,fallback=await self.selected_images(event,n,review)
            for image in images:await event.send(event.image_result(image))
            if fallback:await event.send(event.plain_result(fallback))
            return json.dumps({'index':n,'imageSent':bool(images),'pages':len(images),'textSent':bool(fallback),'message':'结果已发送，无需重复复述'},ensure_ascii=False)
        except UserError as error:return str(error)
        except Exception:return '单局图片请求失败，请检查网站连接后重试'

    @filter.llm_tool(name="owqs_cancel")
    async def cancel_tool(self, event: AstrMessageEvent) -> str:
        """用户明确要求取消当前守望先锋战绩查询时使用，只取消当前发送者的任务。"""
        try:
            return "已请求取消查询" if await self.manager.cancel(owner_key(event)) else "当前没有未完成的查询"
        except UserError as error:
            return str(error)

    async def terminate(self):
        await self.manager.close()
        await self.renderer.close()
        self.bindings.close()
