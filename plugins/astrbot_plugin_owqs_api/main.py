import json
from pathlib import Path

from astrbot.api import AstrBotConfig
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

from .api_client import ApiClient, Bindings, Query, QueryManager, UserError, compact_result, format_result, owner_key, parse_query

HELP = """狸狸天眼查 · 网站 API
/owqs 绑定 昵称#编号
/owqs 查询 [昵称#编号] [5|10|20] [快|慢]
/owqs 解绑
/owqs 取消
/owqs 帮助
默认搜索最近 10 场、快模式；不填昵称时使用绑定。
分析与逐局摘要展示最近 10 场。查询消耗插件 API 密钥所属账号的网站额度。
也可直接对 Bot 说“查询 某人#12345 的守望先锋战绩”，由 owqs_query 工具查询。"""


class Main(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        directory = Path(get_astrbot_data_path()) / "plugin_data" / "astrbot_plugin_owqs_api"
        self.bindings = Bindings(directory)
        self.client = ApiClient(config.get("api_base", ""), config.get("api_key", ""))
        self.manager = QueryManager(self.client, timeout=config.get("query_timeout", 600), max_pending=config.get("max_pending", 5))

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
                yield event.plain_result(format_result(result, query))
            else:
                yield event.plain_result(HELP)
        except UserError as error:
            yield event.plain_result(str(error))
        except Exception:
            yield event.plain_result("查询插件执行失败，请管理员检查网站连接与插件配置")

    @filter.llm_tool(name="owqs_query")
    async def query_tool(self, event: AstrMessageEvent, battletag: str = "", limit: int = 10, mode: str = "fast") -> str:
        """通过狸狸天眼查网站 API 获取守望先锋快速对局、强度和个人段位参考。用户请求查询战绩时使用；必须提供完整战网昵称或使用用户已有绑定，不能编造编号。此工具消耗网站查询额度，默认快模式，只有用户要求补采时用 slow。规则评分不代表官方 MMR。

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
            return json.dumps(compact_result(result, query), ensure_ascii=False)
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

    @filter.llm_tool(name="owqs_cancel")
    async def cancel_tool(self, event: AstrMessageEvent) -> str:
        """用户明确要求取消当前守望先锋战绩查询时使用，只取消当前发送者的任务。"""
        try:
            return "已请求取消查询" if await self.manager.cancel(owner_key(event)) else "当前没有未完成的查询"
        except UserError as error:
            return str(error)

    async def terminate(self):
        await self.manager.close()
        self.bindings.close()
