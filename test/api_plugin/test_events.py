import unittest
from unittest.mock import AsyncMock, patch
import urllib.parse
from test_client import client


class EventTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_date_query_polls_without_creating_battle_jobs_and_keeps_long_backoff(self):
        api=client.ApiClient('https://site.test','owqs_'+'a'*64)
        api.request=AsyncMock(side_effect=[{'state':'pending','retryAfter':30},{'matches':[],'total':0}])
        with patch.object(client.asyncio,'sleep',new_callable=AsyncMock) as sleep:
            result=await api.events(from_date='2026-10-01',to_date='2026-10-18',series='all')
        self.assertEqual(result['total'],0);sleep.assert_awaited_once_with(30)
        params=urllib.parse.parse_qs(urllib.parse.urlsplit(api.request.call_args.args[1]).query)
        self.assertEqual(params['series'],['all']);self.assertEqual(params['status'],['auto']);self.assertEqual(api.request.await_count,2)
        api.request=AsyncMock(return_value={'state':'pending','retryAfter':300})
        with patch.object(client.asyncio,'sleep',new_callable=AsyncMock) as sleep:
            result=await api.events(from_date='2026-10-01',to_date='2026-10-18')
        sleep.assert_not_awaited();self.assertIn('正在补查',client.format_events(result));self.assertNotIn('没有符合',client.format_events(result))

    async def test_series_defaults_and_unsafe_or_oversized_date_query_are_rejected_before_network(self):
        self.assertEqual(client.event_filters()['series'],'owcs');self.assertEqual(client.event_filters(series='全部')['series'],'all')
        api=client.ApiClient('https://site.test','owqs_'+'a'*64);api.request=AsyncMock()
        for values in ({'series':'bad'},{'from_date':'2020-01-01','to_date':'2026-10-18'}):
            with self.assertRaises(client.UserError):await api.events(**values)
        api.request.assert_not_awaited()

    async def test_filters_are_encoded_on_a_read_only_website_api_request(self):
        api=client.ApiClient('https://site.test','owqs_'+'a'*64)
        api.request=AsyncMock(return_value={'matches':[]})
        await api.events(from_date='2026-10-18',to_date='2026-10-20',region='中国',team='All Gamers',tournament='Stage 3',status='赛果',limit=5.0)
        method,route=api.request.call_args.args
        self.assertEqual(method,'GET');self.assertTrue(route.startswith('/api/v1/events?'))
        values=urllib.parse.parse_qs(urllib.parse.urlsplit(route).query)
        self.assertEqual(values['team'],['All Gamers']);self.assertEqual(values['status'],['completed']);self.assertEqual(values['limit'],['5'])

    async def test_invalid_filters_fail_before_network(self):
        api=client.ApiClient('https://site.test','owqs_'+'a'*64);api.request=AsyncMock()
        for values in ({'from_date':'2026-02-30'},{'from_date':'2026-10-20','to_date':'2026-10-18'},{'limit':0},{'limit':21},{'limit':True},{'limit':1.5},{'status':'live'},{'team':'bad\nname'}):
            with self.assertRaises(client.UserError):await api.events(**values)
        api.request.assert_not_awaited()

    async def test_command_quoting_and_result_format(self):
        values=client.parse_events('赛区=中国 战队="All Gamers" 状态=赛果 条数=5')
        self.assertEqual(values['team'],'All Gamers')
        for text in ('赛区=中国 赛区=韩国','refresh=true','战队="bad'):
            with self.assertRaises(client.UserError):client.parse_events(text)
        text=client.format_events({'updatedAt':'2026-10-17T16:00:00Z','stale':True,'total':1,'matches':[{'startsAt':'2026-10-17T16:00:00Z','teams':[{'name':'A'},{'name':'B'}],'scores':[3,0],'bestOf':5,'status':'completed','region':'中国','tournament':'OWCS China'}]})
        self.assertIn('10-18 00:00',text);self.assertIn('3 : 0',text);self.assertIn('BO5',text);self.assertIn('上次同步',text)
