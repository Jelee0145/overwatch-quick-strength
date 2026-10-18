import asyncio
import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = 'owqs_api_handler_test'
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / 'plugins/astrbot_plugin_owqs_api')]
sys.modules[PACKAGE] = package
renderer = importlib.import_module(PACKAGE + '.renderer')
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1100"><rect width="1440" height="1100" fill="#123456"/><text x="30" y="50">测试图表</text></svg>'
CHART = {'version':1,'format':'svg','svg':SVG}

class ChartTests(unittest.TestCase):
    def test_only_bounded_offline_svg_is_accepted(self):
        self.assertEqual(renderer.chart_svg(CHART), SVG)
        for content in [SVG.replace('<rect', '<script/><rect'), SVG.replace('<rect', '<image href="https://evil.test/x"/><rect'), SVG.replace('<rect', '<rect onload="alert(1)"/><rect'), SVG.replace('1440','9999'), '<!DOCTYPE svg>' + SVG]:
            with self.assertRaises(renderer.UserError):
                renderer.chart_svg({**CHART,'svg':content})

    def test_old_image_cleanup_stays_inside_private_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            r=renderer.Renderer(directory)
            image=r.directory / ('a'*32+'.png');image.write_bytes(b'x')
            with patch.object(renderer.time,'time',return_value=image.stat().st_mtime+90000):r.cleanup()
            self.assertFalse(image.exists())

class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        event_module=types.ModuleType('astrbot.api.event')
        event_module.AstrMessageEvent=object
        event_module.filter=types.SimpleNamespace(command=lambda *a,**kw:lambda f:f,llm_tool=lambda *a,**kw:lambda f:f)
        star_module=types.ModuleType('astrbot.api.star')
        class Star:
            def __init__(self,context):pass
        star_module.Star=Star;star_module.Context=object
        path_module=types.ModuleType('astrbot.core.utils.astrbot_path')
        path_module.get_astrbot_data_path=lambda:self.temp.name
        api_module=types.ModuleType('astrbot.api');api_module.AstrBotConfig=dict
        modules={'astrbot.api':api_module,'astrbot.api.event':event_module,'astrbot.api.star':star_module,'astrbot.core.utils.astrbot_path':path_module}
        with patch.dict(sys.modules,modules):
            main=importlib.import_module(PACKAGE+'.main')
        self.plugin=main.Main(None,{'api_base':'https://test.example','free_api_key':'owqs_'+'a'*64})
        self.result={'id':'a'*64,'chart':CHART,'analysis':{'matches':[{'mid':'left'},{'mid':'right'}],'summary':{}}}
        self.plugin.client.account=AsyncMock(return_value={'valid':True,'tier':'free'})
        self.plugin.manager.query=AsyncMock(return_value=self.result)
        self.plugin.renderer.render=AsyncMock(return_value='/private/chart.png')
        self.event=types.SimpleNamespace(get_platform_id=lambda:'test',get_self_id=lambda:'bot',get_sender_id=lambda:'user',is_private_chat=lambda:True,get_message_str=lambda:'owqs 查询 Name#123 快',should_call_llm=lambda value:None,plain_result=lambda text:('text',text),image_result=lambda path:('image',path),send=AsyncMock())

    async def asyncTearDown(self):
        await self.plugin.terminate();self.temp.cleanup()

    async def test_command_defaults_to_image(self):
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertEqual(messages[-1],('image','/private/chart.png'))
        self.plugin.manager.query.assert_awaited_once()

    async def test_events_tool_and_command_filter_without_query_or_review_quota(self):
        data={'matches':[], 'total':0, 'updatedAt':'2026-10-18T00:00:00Z'}
        self.plugin.client.events=AsyncMock(return_value=data)
        reserve=Mock(side_effect=AssertionError('events must not spend quota'))
        self.plugin.bindings.reserve=reserve
        text=await self.plugin.events_tool(self.event,region='CN',team='AG',status='completed',limit=5)
        self.assertIn('没有符合条件',text)
        self.plugin.client.events.assert_awaited_once_with(from_date='',to_date='',region='CN',tournament='',team='AG',status='completed',limit=5)
        self.plugin.manager.query.assert_not_awaited();reserve.assert_not_called()
        self.event.get_message_str=lambda:'owqs 赛程 赛区=中国 战队="All Gamers" 状态=赛果 条数=5'
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertEqual(messages[-1][0],'text');self.assertIn('服务器每日同步一次',messages[-1][1]);self.plugin.manager.query.assert_not_awaited()

    async def test_tool_sends_image_and_does_not_return_internal_path(self):
        text=await self.plugin.query_tool(self.event,'Name#123')
        self.event.send.assert_awaited_once_with(('image','/private/chart.png'))
        self.assertIn('"imageSent": true',text)
        self.assertNotIn('/private/',text)

    async def test_render_failure_reuses_same_query_result_for_text(self):
        self.plugin.renderer.render.side_effect=RuntimeError('renderer unavailable')
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertEqual(messages[-1][0],'text');self.assertIn('不会重复查询',messages[-1][1])
        self.plugin.manager.query.assert_awaited_once()
        self.plugin.manager.query.reset_mock()
        text=await self.plugin.query_tool(self.event,'Name#123')
        self.assertIn('"textSent": true',text);self.plugin.manager.query.assert_awaited_once()

    async def test_indexed_data_uses_remembered_query_without_requerying(self):
        await self.plugin.query_tool(self.event,'Name#123')
        self.plugin.manager.query.reset_mock()
        self.plugin.client.match=AsyncMock(return_value={'match':{'index':2,'mapName':'测试地图'}})
        self.plugin.renderer.render_data=AsyncMock(return_value='/private/data.png')
        self.event.get_message_str=lambda:'owqs 数据 2'
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertEqual(messages[-1],('image','/private/data.png'))
        self.plugin.client.match.assert_awaited_once_with('a'*64,2)
        self.plugin.manager.query.assert_not_awaited()

    async def test_invalid_index_and_other_sender_never_create_paid_review(self):
        self.plugin.client.review=AsyncMock()
        self.event.get_message_str=lambda:'owqs 锐评 11'
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertEqual(messages[-1][0],'text');self.plugin.client.review.assert_not_awaited()
        self.plugin.bindings.remember('["test","bot","other"]',self.result)
        text=await self.plugin.match_review_tool(self.event,1)
        self.assertIn('请先',text);self.plugin.client.review.assert_not_awaited()

    async def test_cached_review_tool_sends_all_image_pages(self):
        self.plugin.bindings.remember('["test","bot","user"]',self.result,self.plugin.route('["test","bot","user"]')[1])
        self.plugin.client.match=AsyncMock(return_value={'match':{}})
        self.plugin.client.review=AsyncMock(return_value={'cached':True,'match':{'index':1},'review':{'text':'复盘','cached':True}})
        self.plugin.client.review_status=AsyncMock()
        self.plugin.renderer.render_review=AsyncMock(return_value=['/private/one.png','/private/two.png'])
        report=await self.plugin.match_review_tool(self.event,1)
        self.assertIn('"pages": 2',report);self.assertEqual(self.event.send.await_count,2)
        self.plugin.client.review_status.assert_not_awaited()

    async def test_failed_new_chart_keeps_previous_visible_numbering(self):
        owner='["test","bot","user"]'
        self.plugin.bindings.remember(owner,{'id':'b'*64,'analysis':{'matches':[{'mid':'previous'}]}})
        self.plugin.renderer.render.side_effect=RuntimeError('render failed')
        await self.plugin.query_tool(self.event,'Name#123')
        self.assertEqual(self.plugin.bindings.selection(owner,1),'b'*64)

    async def test_guest_requires_explicit_id_every_time_and_daily_query_limit_persists(self):
        owner='["test","bot","user"]'
        self.plugin.config['free_daily_limit']=1
        self.assertIn('"imageSent": true',await self.plugin.query_tool(self.event,'Name#123'))
        self.assertIn('完整游戏 ID',await self.plugin.query_tool(self.event))
        self.assertIn('次数已用完',await self.plugin.query_tool(self.event,'Name#123'))
        self.assertEqual(self.plugin.manager.query.await_count,1)
        self.assertIsNone(self.plugin.bindings.last_tag(owner,self.plugin.route(owner)[1]))
        self.assertFalse(self.plugin.manager.query.call_args.kwargs['client'].sync_history)

    async def test_bound_key_routes_to_its_owner_and_reuses_last_game_id(self):
        owner='["test","bot","user"]';key='owqs_'+'b'*64
        self.plugin.bindings.bind_key(owner,key)
        text=await self.plugin.query_tool(self.event,'Bound#123')
        self.assertIn('"imageSent": true',text)
        api=self.plugin.manager.query.call_args.kwargs['client']
        self.assertEqual(api.key,key);self.assertTrue(api.sync_history)
        self.assertIn('"imageSent": true',await self.plugin.query_tool(self.event))
        self.assertEqual(self.plugin.manager.query.call_args.args[1].tag,'Bound#123')
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],0)

    async def test_account_default_is_used_only_for_bound_sender(self):
        owner='["test","bot","user"]'
        self.plugin.bindings.bind_key(owner,'owqs_'+'b'*64)
        with patch.object(self.plugin.client.__class__,'account',AsyncMock(return_value={'valid':True,'lastBattletag':'Website#123'})):
            text=await self.plugin.query_tool(self.event)
        self.assertIn('"imageSent": true',text)
        self.assertEqual(self.plugin.manager.query.call_args.args[1].tag,'Website#123')

    async def test_invalid_binding_never_echoes_key_or_overwrites_previous_binding(self):
        owner='["test","bot","user"]';key='owqs_'+'b'*64
        self.plugin.bindings.bind_key(owner,key)
        for candidate in ('invalid','owqs_'+'c'*64):
            self.event.get_message_str=lambda:'owqs 绑定 '+candidate
            with patch.object(self.plugin.client.__class__,'account',AsyncMock(side_effect=renderer.UserError('绑定错误，请上网页版确认。'))):
                messages=[m async for m in self.plugin.owqs(self.event)]
            self.assertIn('绑定错误',messages[-1][1]);self.assertNotIn(candidate,messages[-1][1])
            self.assertEqual(self.plugin.bindings.key(owner),key)
        self.event.is_private_chat=lambda:False
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertIn('私聊',messages[-1][1])

    async def test_revoked_bound_key_does_not_use_free_sponsor(self):
        owner='["test","bot","user"]';self.plugin.bindings.bind_key(owner,'owqs_'+'b'*64)
        self.plugin.manager.query.side_effect=renderer.UserError('绑定错误，请上网页版确认。')
        text=await self.plugin.query_tool(self.event,'Name#123')
        self.assertIn('绑定错误',text)
        self.assertEqual(self.plugin.manager.query.await_count,1)
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],0)

    async def test_free_review_cache_is_usable_at_zero_remaining_and_data_does_not_charge(self):
        owner='["test","bot","user"]';await self.plugin.query_tool(self.event,'Name#123')
        self.plugin.config['free_review_daily_limit']=1
        self.plugin.client.match=AsyncMock(return_value={'match':{'index':1}})
        self.plugin.client.review=AsyncMock(return_value={'id':'b'*64})
        self.plugin.client.review_status=AsyncMock(return_value={'state':'done','match':{'index':1},'review':{'text':'已有锐评'}})
        self.plugin.renderer.render_review=AsyncMock(return_value=['/private/review.png'])
        self.plugin.renderer.render_data=AsyncMock(return_value='/private/data.png')
        self.assertIn('"imageSent": true',await self.plugin.match_review_tool(self.event,1))
        self.assertIn('"imageSent": true',await self.plugin.match_review_tool(self.event,1))
        self.assertEqual(self.plugin.client.review.await_count,1)
        self.assertIn('次数已用完',await self.plugin.match_review_tool(self.event,2))
        before=self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0]
        self.assertIn('"imageSent": true',await self.plugin.match_data_tool(self.event,2))
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],before)

    async def test_definite_failure_refunds_free_reservation_but_unknown_remote_outcome_keeps_it(self):
        self.plugin.manager.query.side_effect=renderer.UserError('已失败')
        await self.plugin.query_tool(self.event,'Name#123')
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],0)
        self.plugin.manager.query.side_effect=renderer.UserError('网络中断',uncertain=True)
        await self.plugin.query_tool(self.event,'Name#123')
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],1)


    async def test_bound_data_and_review_keep_the_query_key_and_do_not_charge_free_counts(self):
        from unittest.mock import Mock
        main=self.plugin.route.__globals__;owner='["test","bot","user"]';key='owqs_'+'b'*64
        self.plugin.bindings.bind_key(owner,key)
        bound=types.SimpleNamespace(key=key,validate=Mock(),match=AsyncMock(return_value={'match':{'index':1}}),review=AsyncMock(return_value={'cached':True,'match':{'index':1},'review':{'text':'复用'}}))
        with patch.dict(main,{'ApiClient':Mock(return_value=bound)}):
            scope=self.plugin.route(owner)[1]
            self.plugin.bindings.remember(owner,self.result,scope)
            self.plugin.renderer.render_data=AsyncMock(return_value='/private/data.png')
            self.plugin.renderer.render_review=AsyncMock(return_value=['/private/review.png'])
            self.assertIn('"imageSent": true',await self.plugin.match_data_tool(self.event,1))
            self.assertIn('"imageSent": true',await self.plugin.match_review_tool(self.event,1))
        bound.match.assert_awaited_once_with('a'*64,1);bound.review.assert_awaited_once()
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],0)
        self.plugin.bindings.unbind(owner)
        self.assertIn('请先',await self.plugin.match_data_tool(self.event,1))

    async def test_private_binding_validates_without_echo_and_saves_only_success(self):
        key='owqs_'+'b'*64
        with patch.object(self.plugin.client.__class__,'account',AsyncMock(return_value={'valid':True})) as validate:
            self.event.get_message_str=lambda:'owqs 绑定 '+key
            messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertIn('绑定成功',messages[-1][1]);self.assertNotIn(key,messages[-1][1])
        self.assertEqual(self.plugin.bindings.key('["test","bot","user"]'),key)
        validate.assert_awaited_once()
        self.assertIn('私聊',await self.plugin.bind_tool(self.event))


    async def test_free_service_rejects_personal_key_and_never_falls_back_to_legacy_config(self):
        self.plugin.client.account=AsyncMock(return_value={'valid':True,'tier':'standard'})
        text=await self.plugin.query_tool(self.event,'Name#123')
        self.assertIn('free 层级',text);self.plugin.manager.query.assert_not_awaited()
        self.assertEqual(self.plugin.bindings.db.execute('SELECT count(*) FROM free_usage').fetchone()[0],0)
        main=self.plugin.route.__globals__
        old=main['ApiClient']
        with patch.dict(main,{'ApiClient':lambda *a,**kw:old(*a,**kw)}):
            self.plugin.client=old('https://test.example','')
            self.plugin.config['api_key']='owqs_'+'a'*64
            self.assertIn('free_api_key',await self.plugin.query_tool(self.event,'Name#123'))

    async def test_free_tier_key_cannot_be_bound_as_personal(self):
        with patch.object(self.plugin.client.__class__,'account',AsyncMock(return_value={'valid':True,'tier':'free'})):
            self.event.get_message_str=lambda:'owqs 绑定 owqs_'+'b'*64
            messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertIn('只能由管理员单独配置',messages[-1][1])
        self.assertIsNone(self.plugin.bindings.key('["test","bot","user"]'))


    async def test_natural_language_tool_preserves_user_case_and_accepts_schema_number_variants(self):
        self.event.get_message_str=lambda:'帮我查询 Demo#12345 的最近战绩'
        text=await self.plugin.query_tool(self.event,'demo#12345',10.0,'快')
        self.assertIn('"imageSent": true',text)
        query=self.plugin.manager.query.call_args.args[1]
        self.assertEqual((query.tag,query.limit,query.mode),('Demo#12345',10,'fast'))
        self.assertIn('"imageSent": true',await self.plugin.query_tool(self.event,'demo#12345','5','慢'))
        self.assertEqual(self.plugin.manager.query.call_args.args[1].mode,'slow')
        self.plugin.manager.query.reset_mock()
        for value in (True,10.5,'invalid'):
            self.assertIn('场数只支持',await self.plugin.query_tool(self.event,'demo#12345',value))
        self.plugin.manager.query.assert_not_awaited()

    async def test_match_tool_accepts_integral_schema_number_without_requerying(self):
        await self.plugin.query_tool(self.event,'Name#123')
        self.plugin.client.match=AsyncMock(return_value={'match':{'index':1}})
        self.plugin.renderer.render_data=AsyncMock(return_value='/private/data.png')
        self.assertIn('"imageSent": true',await self.plugin.match_data_tool(self.event,1.0))


class DocumentTests(unittest.TestCase):
    def test_website_markup_and_script_safe_payload_preserve_content(self):
        import json
        documents=importlib.import_module(PACKAGE+'.documents')
        detail={'index':1,'count':10,'battletag':'</script><script>user</script>','webView':{'raw':{},'options':{},'match':{}}}
        html=documents.data_document(detail)
        self.assertIn('id="players"',html)
        self.assertIn('英雄表现',html)
        self.assertNotIn('</script><script>user',html)
        value={'text':'</script><img src=x> & 中文'}
        encoded=documents.script_json(value)
        self.assertNotIn('<',encoded)
        self.assertEqual(json.loads(encoded),value)
        text='锐评 <script> 不执行\n'*400
        pages=documents.review_documents(detail,{'text':text})
        self.assertGreater(len(pages),1)
        self.assertTrue(all('class="ai-review"' in p for p in pages))
        self.assertTrue(all('INPUT.review' in p for p in pages))

    def test_missing_website_view_fails_instead_of_drawing_another_style(self):
        documents=importlib.import_module(PACKAGE+'.documents')
        with self.assertRaises(ValueError): documents.data_document({})
