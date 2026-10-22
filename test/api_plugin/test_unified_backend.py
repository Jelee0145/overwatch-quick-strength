import asyncio
import tempfile
import unittest
from unittest.mock import AsyncMock
from test_client import client, result


class PersistedQueryTests(unittest.TestCase):
    def test_retry_keeps_request_job_and_free_reservation_after_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            store = client.Bindings(directory)
            query = client.Query('Demo#123', 20, 'slow', '66')
            reservation = store.reserve('sender', 'query', 1)
            pending = store.start_query('sender', 'free:scope', query, reservation)
            store.query_job('sender', pending['requestId'], 'a' * 64)
            store.close()
            store = client.Bindings(directory)
            resumed = store.start_query('sender', 'free:scope', query)
            self.assertEqual(resumed, {**pending, 'job': 'a' * 64})
            with self.assertRaises(client.UserError):
                store.pending_query('sender', 'free:scope', client.Query('Other#123'))
            with self.assertRaises(client.UserError):
                store.pending_query('sender', 'bound:other', query)
            self.assertIsNone(store.pending_query('other', 'free:scope', query))
            self.assertEqual(store.db.execute('SELECT count(*) FROM free_usage').fetchone()[0], 1)
            store.db.execute("UPDATE query_requests SET job='',created=0 WHERE owner='sender'")
            store.db.commit()
            with self.assertRaisesRegex(client.UserError, '保留期限'):
                store.pending_query('sender', 'free:scope', query)
            store.finish_query('sender')
            self.assertNotEqual(store.start_query('sender', 'free:scope', query)['requestId'], pending['requestId'])
            store.close()


class DeliveryStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_last_query_and_window_change_only_after_delivery_confirmation(self):
        import test_renderer
        fixture = test_renderer.HandlerTests()
        await fixture.asyncSetUp()
        try:
            plugin = fixture.plugin
            owner = '["test","bot","user"]'
            plugin.bindings.bind_key(owner, 'owqs_' + 'b' * 64)
            scope = plugin.route(owner)[1]
            gate = asyncio.Event()
            async def send(*args):
                await gate.wait()
                return True
            plugin.context.send_message = AsyncMock(side_effect=send)
            await plugin.query_tool(fixture.event, 'Name#123')
            await asyncio.sleep(0)
            self.assertIsNone(plugin.bindings.last_tag(owner, scope))
            with self.assertRaises(test_renderer.renderer.UserError):
                plugin.bindings.selection(owner, 1, scope)
            gate.set()
            await fixture.settle()
            self.assertEqual(plugin.bindings.last_tag(owner, scope), 'Name#123')
            self.assertEqual(plugin.bindings.selection(owner, 1, scope), 'a' * 64)
        finally:
            await fixture.asyncTearDown()

    async def test_failed_delivery_does_not_replace_last_query(self):
        import test_renderer
        fixture = test_renderer.HandlerTests()
        await fixture.asyncSetUp()
        try:
            plugin = fixture.plugin
            owner = '["test","bot","user"]'
            plugin.bindings.bind_key(owner, 'owqs_' + 'b' * 64)
            plugin.context.send_message = AsyncMock(return_value=False)
            await plugin.query_tool(fixture.event, 'Name#123')
            await fixture.settle()
            self.assertIsNone(plugin.bindings.last_tag(owner, plugin.route(owner)[1]))
        finally:
            await fixture.asyncTearDown()


class UnifiedClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_query_uses_supplied_request_id_and_preserves_legacy_picture_options(self):
        api = client.ApiClient('https://site.test', 'owqs_' + 'a' * 64, sync_history=False)
        api.request = AsyncMock(return_value={'id': 'b' * 64})
        await api.create(client.Query('Demo#123', 20, 'slow', '66'), 'logical-query')
        method, route, body = api.request.call_args.args
        self.assertEqual((method, route), ('POST', '/api/v1/query'))
        self.assertEqual(body['requestId'], 'logical-query')
        self.assertEqual((body['statisticsRange'], body['side'], body['strategy'], body['estimate']), ('10', 'all', 'legacy', True))
        self.assertFalse(body['syncHistory'])
        api.request = AsyncMock(side_effect=client.UserError('timeout', uncertain=True))
        with self.assertRaises(client.UserError):
            await api.create(client.Query('Demo#123'), 'logical-query')
        self.assertEqual(api.request.await_count, 1)

    async def test_resume_polls_saved_job_without_creating_again(self):
        api = client.ApiClient('https://site.test', 'owqs_' + 'a' * 64)
        api.create = AsyncMock()
        api.status = AsyncMock(return_value=result())
        api.cancel = AsyncMock()
        manager = client.QueryManager(api)
        value = await manager.query('owner', client.Query('Demo#123'), request_id='same', job_id='b' * 64)
        self.assertEqual(value['state'], 'done')
        api.create.assert_not_awaited()
        api.status.assert_awaited_once_with('b' * 64)
        api.cancel.assert_not_awaited()

    async def test_historical_routes_preserve_reference_and_reject_free_scope(self):
        api = client.ApiClient('https://site.test', 'owqs_' + 'a' * 64)
        api.request = AsyncMock(return_value={})
        options = {'statisticsRange': 'all', 'pool': '55'}
        await api.history_analysis('Demo#123', options)
        self.assertEqual(api.request.call_args.args, ('POST', '/api/v1/history/analysis', {'battletag': 'Demo#123', 'options': options}))
        await api.historical_match('Demo#123', 'mid', 'b' * 64, options)
        self.assertEqual(api.request.call_args.args[1], '/api/v1/matches/detail')
        await api.historical_review('Demo#123', 'mid', 'b' * 64, 'review-request', options)
        self.assertEqual(api.request.call_args.args[2]['revision'], 'b' * 64)
        self.assertEqual(api.request.call_args.args[2]['requestId'], 'review-request')
        api.sync_history = False
        api.request.reset_mock()
        for operation in (api.history_analysis('Demo#123'), api.historical_match('Demo#123', 'mid', 'b' * 64), api.historical_review('Demo#123', 'mid', 'b' * 64, 'request')):
            with self.assertRaises(client.UserError):
                await operation
        api.request.assert_not_awaited()

    async def test_review_polling_does_not_resubmit_and_preserves_uncertainty(self):
        api = client.ApiClient('https://site.test', 'owqs_' + 'a' * 64)
        api.review_status = AsyncMock(return_value={'state': 'failed'})
        with self.assertRaises(client.UserError) as caught:
            await api.wait_review({'id': 'b' * 64})
        self.assertFalse(caught.exception.uncertain)
        api.review_status = AsyncMock(side_effect=client.UserError('unreachable'))
        with self.assertRaises(client.UserError) as caught:
            await api.wait_review({'id': 'b' * 64})
        self.assertTrue(caught.exception.uncertain)
        api.review_status.assert_awaited_once()
