import asyncio
import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

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
        self.plugin=main.Main(None,{'api_base':'https://test.example','api_key':'owqs_'+'a'*64})
        self.result={'chart':CHART,'analysis':{'matches':[],'summary':{}}}
        self.plugin.manager.query=AsyncMock(return_value=self.result)
        self.plugin.renderer.render=AsyncMock(return_value='/private/chart.png')
        self.event=types.SimpleNamespace(get_platform_id=lambda:'test',get_self_id=lambda:'bot',get_sender_id=lambda:'user',get_message_str=lambda:'owqs 查询 Name#123 快',should_call_llm=lambda value:None,plain_result=lambda text:('text',text),image_result=lambda path:('image',path),send=AsyncMock())

    async def asyncTearDown(self):
        await self.plugin.terminate();self.temp.cleanup()

    async def test_command_defaults_to_image(self):
        messages=[m async for m in self.plugin.owqs(self.event)]
        self.assertEqual(messages[-1],('image','/private/chart.png'))
        self.plugin.manager.query.assert_awaited_once()

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
