import asyncio
import json
import re
import uuid
from pathlib import Path

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

from .api_client import ApiClient, Bindings, Query, QueryManager, UserError, compact_result, format_result, owner_key, parse_query, credential_scope, valid_key, BIND_ERROR
from .renderer import Renderer

HELP = """狸狸天眼查 · 网站 API
/owqs 绑定 网站Key（仅私聊）
/owqs 查询 [昵称#编号] [5|10|20] [快|慢]
/owqs 数据 n
/owqs 锐评 n
/owqs 解绑
/owqs 取消
/owqs 帮助
绑定 Key 后扣除该网站账号额度；可省略游戏 ID，使用上一次查询的 ID。
未绑定时每次必须填写完整游戏 ID；按发送者计算免费次数，查询／锐评各默认每天 10 次（管理员可配置，北京时间零点重置）。数据图不扣次数，已有锐评复用。
免费记录只在 Bot 本地管理，不参加云端历史同步。网站临时任务保留约一小时，以便读取数据和锐评。
默认快查询、搜索 10 场并发送图片；数据／锐评的 n 对应最近一张查询图从左到右 1—10。换绑或解绑后需重新查询。不要在群聊发送 Key。"""


class Main(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        directory = Path(get_astrbot_data_path()) / "plugin_data" / "astrbot_plugin_owqs_api"
        self.bindings = Bindings(directory)
        self.renderer = Renderer(directory)
        self.client = ApiClient(config.get("api_base", ""), config.get("free_api_key", ""), sync_history=False)
        self.manager = QueryManager(self.client, timeout=config.get("query_timeout", 600), max_pending=config.get("max_pending", 5))
        self.review_pending = set()
        self.query_pending = set()
        self.review_slot = asyncio.Semaphore(1)

    def route(self, owner):
        key=self.bindings.key(owner)
        client=ApiClient(self.config.get('api_base',''),key) if key else self.client
        if not key and not client.key:raise UserError('请管理员配置独立的 free_api_key，或先私聊绑定个人网站 Key')
        client.validate()
        return client, ('bound:' if key else 'free:')+credential_scope(client.key), not bool(key)

    def ensure_idle(self, owner):
        if owner in self.query_pending or owner in self.manager.active or owner in self.review_pending:
            raise UserError('你有正在处理的查询或锐评，请完成或取消后再换绑／解绑')

    async def bind_key(self, event, key):
        owner=owner_key(event);self.ensure_idle(owner)
        if not getattr(event,'is_private_chat',lambda:False)():
            raise UserError('请私聊 Bot 使用 /owqs 绑定 网站Key，不要在群聊发送密钥')
        key=valid_key(key)
        client=ApiClient(self.config.get('api_base',''),key)
        account=await client.account()
        if account.get('valid') is not True:raise UserError(BIND_ERROR)
        if account.get('tier')=='free':raise UserError('绑定错误，请上网页版确认。免费服务 Key 只能由管理员单独配置。')
        self.bindings.bind_key(owner,key)
        return '网站 Key 绑定成功。查询将使用该 Key 所属账号额度；可 /owqs 查询 昵称#编号，之后可省略 ID。'

    async def run_query(self, owner, arguments):
        if owner in self.query_pending:raise UserError('你已有查询正在处理，请等待完成')
        if len(self.query_pending)>=self.manager.max_pending:raise UserError('插件查询队列已满，请稍后再试')
        self.query_pending.add(owner)
        reservation=None
        try:
            client,scope,free=self.route(owner)
            if free and (await client.account()).get('tier')!='free':
                raise UserError('免费服务配置错误：请管理员单独配置 free 层级的 free_api_key，不能使用个人账号 Key')
            default=None if free else self.bindings.last_tag(owner,scope)
            if not free and not default and '#' not in arguments:
                account=await client.account();default=account.get('lastBattletag')
            query=parse_query(arguments,default)
            if free:reservation=self.bindings.reserve(owner,'query',self.config.get('free_daily_limit',10))
            result=await self.manager.query(owner,query,client=client)
            if not free:self.bindings.save_last(owner,scope,query.tag)
            return result,query,scope
        except UserError as error:
            if reservation and not error.uncertain:self.bindings.release(reservation)
            raise
        finally:self.query_pending.discard(owner)

    async def selected_images(self, event, n, review=False):
        if isinstance(n,bool) or not re.fullmatch(r"[0-9]{1,2}",str(n)):
            raise UserError("请填写图中从左到右的编号，例如 /owqs 数据 1 或 /owqs 锐评 10")
        n=int(n);owner=owner_key(event);client,scope,free=self.route(owner)
        job=self.bindings.selection(owner,n,scope)
        if not review:
            value=await client.match(job,n);detail=value.get('match') or {}
            try:return [await self.renderer.render_data(detail)],None
            except Exception:return [],f"第 {n} 场数据图生成失败；地图：{detail.get('mapName','未知')}。请在网站查看完整数据。"
        if owner in self.review_pending:raise UserError("你已有锐评排队或生成中，请等待完成")
        if len(self.review_pending)>=5:raise UserError("锐评队列已满，请稍后再试")
        self.review_pending.add(owner)
        reservation=None;completed=False;dispatched=False;failed=False
        try:
            async with self.review_slot:
                value=self.bindings.cached_review(owner,job,n,scope) if free else None
                if value is None:
                    # Verify the live query before spending a free review reservation.
                    if free:
                        await client.match(job,n)
                        reservation=self.bindings.reserve(owner,'review',self.config.get('free_review_daily_limit',10))
                    value=await client.review(job,n,uuid.uuid4().hex)
                    deadline=asyncio.get_running_loop().time()+90
                    if value.get('cached'):
                        if reservation:self.bindings.release(reservation);reservation=None
                    else:
                        dispatched=True
                        review_id=value.get('id')
                        while True:
                            value=await client.review_status(review_id)
                            if value.get('state')=='done':break
                            if value.get('state') in ('failed','cancelled'):
                                failed=True
                                raise UserError("锐评生成失败，网站 AI 额度已释放，请稍后手动重试")
                            if asyncio.get_running_loop().time()>=deadline:raise UserError("锐评仍在生成，请稍后再试；不会自动重复发起 AI 请求",uncertain=True)
                            await asyncio.sleep(1.5)
                    completed=True
                    if free:self.bindings.cache_review(owner,job,n,scope,value)
                detail=value.get('match') or {};report=value.get('review') or {}
                try:return await self.renderer.render_review(detail,report),None
                except Exception:return [],f"第 {n} 场锐评图片生成失败，改用正文：\n"+str(report.get('text') or '网站未返回锐评正文')
        except UserError as error:
            if dispatched and not failed and not completed:error.uncertain=True
            if reservation and not completed and not error.uncertain:self.bindings.release(reservation)
            raise
        finally:self.review_pending.discard(owner)

    @filter.command("owqs")
    async def owqs(self, event: AstrMessageEvent):
        """绑定网站 Key，通过各发送者的凭据或免费额度查询。"""
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
                yield event.plain_result(await self.bind_key(event, arguments))
            elif action == "解绑" and not arguments:
                self.ensure_idle(owner)
                self.bindings.unbind(owner)
                yield event.plain_result("已解除网站 Key 绑定，后续查询使用免费次数且需填写完整游戏 ID")
            elif action == "取消" and not arguments:
                cancelled = await self.manager.cancel(owner)
                yield event.plain_result("已请求取消查询" if cancelled else "你没有排队或运行中的查询")
            elif action == "查询":
                yield event.plain_result("正在准备查询，请稍候；可 /owqs 取消。")
                result,query,scope = await self.run_query(owner, arguments)
                try:
                    image = await self.renderer.render(result.get("chart"))
                    message=event.image_result(image)
                    self.bindings.remember(owner,result,scope)
                    yield message
                except Exception:
                    yield event.plain_result("本次图片生成失败，改用文字结果（不会重复查询）。\n" + format_result(result, query))
            elif action in ('数据','锐评'):
                # Validate the selected window before acknowledging or creating a paid task.
                if not re.fullmatch(r'[0-9]{1,2}',arguments):raise UserError('用法：/owqs '+action+' n，n 为图中从左到右的编号')
                self.bindings.selection(owner,int(arguments),self.route(owner)[1])
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
        """通过网站 API 查询守望先锋战绩，并直接向当前会话发送最近十场强度图片。成功后无需再次用文字复述整份结果。未绑定者必须提供完整游戏 ID；已绑定 Key 者可使用其上次查询 ID，不能编造编号。绑定者消耗其网站额度，未绑定者消耗本地免费次数，默认快模式，只有用户要求补采时用 slow。规则评分不代表官方 MMR。

        Args:
            battletag(string): 完整战网昵称，如昵称#12345。为空时仅允许已绑定 Key 的发送者使用上一次查询 ID。
            limit(number): 搜索最近多少场，仅支持 5、10、20，默认 10；分析窗口固定最近 10 场。
            mode(string): fast 为快查询，slow 为补采其他玩家对局的慢查询，默认 fast。
        """
        try:
            owner = owner_key(event)
            # Query validates types before the optional ID is resolved.
            if type(limit) is not int or limit not in (5,10,20) or mode not in ('fast','slow'):
                raise UserError('查询场数只支持 5、10、20；模式只支持 fast/slow')
            result,query,scope = await self.run_query(owner, f'{battletag.strip()} {limit} {mode}')
            try:
                image = await self.renderer.render(result.get("chart"))
                await event.send(event.image_result(image))
                self.bindings.remember(owner,result,scope)
                return json.dumps({"battletag":query.tag,"imageSent":True,"displayed":len((result.get("analysis") or {}).get("matches") or []),"message":"强度图片已发送，无需重复展示详细文字"},ensure_ascii=False)
            except Exception:
                await event.send(event.plain_result("本次图片生成失败，改用文字结果（不会重复查询）。\n" + format_result(result, query)))
                return json.dumps({"battletag":query.tag,"imageSent":False,"textSent":True,"summary":compact_result(result, query)},ensure_ascii=False)
        except UserError as error:
            return str(error)
        except Exception:
            return "网站战绩查询失败，请联系管理员检查插件配置"

    @filter.llm_tool(name="owqs_bind")
    async def bind_tool(self, event: AstrMessageEvent) -> str:
        """用户要求绑定网站 Key 时，提示在私聊中使用绑定指令；不接收密钥参数，不复述密钥。"""
        return '请私聊 Bot 使用 /owqs 绑定 网站Key。绑定后使用个人网站额度；不要在群聊发送密钥。'

    @filter.llm_tool(name="owqs_match_data")
    async def match_data_tool(self,event: AstrMessageEvent,n:int)->str:
        """发送当前用户最近一次战绩图中第 n 场的真实战斗数据图片。编号从左到右，最多 1—10；必须先查询，不会重新查询战绩。

        Args:
            n(number): 用户指定的图中编号，从左到右 1—10，不得凭空选择对局。
        """
        return await self.send_selected_tool(event,n,False)

    @filter.llm_tool(name="owqs_match_review")
    async def match_review_tool(self,event: AstrMessageEvent,n:int)->str:
        """用户明确要求锐评时，发送其最近一次查询图中第 n 场的 AI 锐评图片。编号从左到右，最多 1—10。已绑定者消耗个人网站 AI 额度，未绑定者按发送者使用本地免费锐评次数；已有相同锐评复用缓存；不要在用户只要数据时调用。

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
