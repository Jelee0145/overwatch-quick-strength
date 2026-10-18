import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "plugins" / "astrbot_plugin_owqs_api"
spec = importlib.util.spec_from_file_location("owqs_api_test_client", SOURCE / "api_client.py")
client = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = client
spec.loader.exec_module(client)


def result():
    return {"state": "done", "analysis": {
        "summary": {"mean": 2200, "observedMean": 2100, "confidencePercent": 90},
        "personalPrediction": {"selected": {"rank": "白金3", "games": 5, "confidence": "中"}},
        "matches": [{"mid": "m1", "t": 1729142400000, "ret": 1, "mean": 2200, "mapName": "测试地图", "players": [{"name": "private-other-player"}]}],
    }, "result": {"private": "private-raw-data"}}


class FakeClient:
    def __init__(self, states=None):
        self.states = list(states or [{"state": "running"}, result()])
        self.creates = 0
        self.cancels = []
        self.created = asyncio.Event()

    def validate(self):
        pass

    async def create(self, query):
        self.creates += 1
        self.created.set()
        return "a" * 64

    async def status(self, job):
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]

    async def cancel(self, job):
        self.cancels.append(job)


class ParserTests(unittest.TestCase):
    def test_nicknames_with_spaces_and_binding_options(self):
        query = client.parse_query("含 空格#12345 20 慢")
        self.assertEqual((query.tag, query.limit, query.mode), ("含 空格#12345", 20, "slow"))
        self.assertEqual(client.parse_query("5 fast", "默认#123").tag, "默认#123")
        for arguments in ("", "bad", "昵称#12 5 10", "昵称#12 快 慢", "昵称\n#12"):
            with self.assertRaises(client.UserError):
                client.parse_query(arguments)
        with self.assertRaises(client.UserError):
            client.Query("昵称#12", True)

    def test_bindings_persist_and_isolate_senders(self):
        with tempfile.TemporaryDirectory() as directory:
            store = client.Bindings(directory)
            store.bind("sender-a", "中文#123")
            self.assertIsNone(store.get("sender-b"))
            store.close()
            store = client.Bindings(directory)
            self.assertEqual(store.get("sender-a"), "中文#123")
            store.unbind("sender-a")
            self.assertIsNone(store.get("sender-a"))
            store.close()

    def test_recent_query_window_survives_reload_and_isolates_senders(self):
        with tempfile.TemporaryDirectory() as directory:
            store=client.Bindings(directory)
            store.remember('a',{'id':'a'*64,'analysis':{'matches':[{'mid':'old'},{'mid':'new'}]}})
            store.close();store=client.Bindings(directory)
            self.assertEqual(store.selection('a',1),'a'*64)
            self.assertEqual(store.selection('a',2),'a'*64)
            for owner,index in [('a',3),('a',0),('a',11),('a',True),('b',1)]:
                with self.assertRaises(client.UserError):store.selection(owner,index)
            store.close()
    def test_summary_is_bounded_and_does_not_expose_raw_rosters(self):
        query = client.Query("昵称#123")
        response = result()
        compact = json.dumps(client.compact_result(response, query), ensure_ascii=False)
        text = client.format_result(response, query)
        self.assertNotIn("private", compact)
        self.assertNotIn("private", text)
        self.assertIn("白金3", text)
        self.assertIn("2200", text)
        self.assertIn("北京时间", text)
        self.assertIn("10-17 13:20 胜", text)


class PolicyTests(unittest.TestCase):
    def test_key_last_id_and_recent_scope_persist_without_reusing_old_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            store=client.Bindings(directory);key='owqs_'+'1'*64
            store.bind_key('a',key);store.save_last('a','bound:one','Name#123')
            store.remember('a',{'id':'a'*64,'analysis':{'matches':[{'mid':'one'}]}},'bound:one')
            store.close();store=client.Bindings(directory)
            self.assertEqual(store.key('a'),key);self.assertIsNone(store.key('b'))
            self.assertEqual(store.last_tag('a','bound:one'),'Name#123');self.assertIsNone(store.last_tag('a','bound:two'))
            with self.assertRaises(client.UserError):store.selection('a',1,'bound:two')
            store.bind_key('a','owqs_'+'2'*64)
            self.assertIsNone(store.last_tag('a','bound:one'))
            with self.assertRaises(client.UserError):store.selection('a',1)
            store.unbind('a');self.assertIsNone(store.key('a'));store.close()

    def test_free_query_and_review_quotas_are_local_separate_persistent_and_reset_in_beijing(self):
        from datetime import datetime,timezone
        before=datetime(2026,10,18,15,59,tzinfo=timezone.utc)
        after=datetime(2026,10,18,16,0,tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            store=client.Bindings(directory)
            token=store.reserve('a','query',1,before)
            store.reserve('a','review',1,before);store.reserve('b','query',1,before)
            store.close();store=client.Bindings(directory)
            with self.assertRaises(client.UserError):store.reserve('a','query',1,before)
            with self.assertRaises(client.UserError):store.reserve('a','review',1,before)
            store.release(token);store.reserve('a','query',1,before)
            store.reserve('a','query',1,after)
            with self.assertRaises(client.UserError):store.reserve('a','query',1,after)
            with self.assertRaises(client.UserError):store.reserve('a','query',0,after)
            store.close()


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.key = "owqs_" + "b" * 64
        self.api = client.ApiClient("https://site.test:8443", self.key)

    def test_only_final_https_origin_and_formatted_key_are_accepted(self):
        self.api.validate()
        for base in ("http://site.test", "https://user:password@site.test", "https://site.test/api", "https://site.test?key=secret", "https://site.test#fragment"):
            with self.assertRaises(client.UserError):
                client.ApiClient(base, self.key).validate()
        with self.assertRaises(client.UserError):
            client.ApiClient("https://site.test", "bad").validate()

    def test_auth_errors_redirects_and_network_failures_never_echo_credentials(self):
        for code in (301, 302, 307, 401, 403, 429, 500):
            self.api.opener.open = Mock(side_effect=urllib.error.HTTPError("https://site.test/" + self.key, code, self.key, {}, None))
            with self.assertRaises(client.UserError) as caught:
                self.api._request("POST", "/api/v1/query", {})
            self.assertNotIn(self.key, str(caught.exception))
            self.assertEqual(self.api.opener.open.call_count, 1)
        self.api.opener.open = Mock(side_effect=urllib.error.URLError(self.key))
        with self.assertRaises(client.UserError) as caught:
            self.api._request("POST", "/api/v1/query", {})
        self.assertNotIn(self.key, str(caught.exception))
        self.assertIsNone(client.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.test"))

    def test_response_bytes_are_decoded_together_and_payload_is_capped(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({"message": "中文🦊"}, ensure_ascii=False).encode()
        self.api.opener.open = Mock(return_value=response)
        self.assertEqual(self.api._request("GET", "/api/v1/jobs/a")["message"], "中文🦊")
        request = self.api.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer " + self.key)
        response.read.return_value = b"x" * (8 * 1024 * 1024 + 1)
        with self.assertRaises(client.UserError):
            self.api._request("GET", "/api/v1/jobs/a")


class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_and_paused_jobs_poll_existing_job_without_creating_again(self):
        api = FakeClient([{"state": "paused"}, result()])
        manager = client.QueryManager(api, poll_interval=0.01)
        output = await manager.query("owner", client.Query("昵称#123"))
        self.assertEqual(output["state"], "done")
        self.assertEqual(api.creates, 1)
        self.assertEqual(api.cancels, [])
        self.assertEqual(manager.active, {})

    async def test_duplicate_owner_does_not_spend_again_and_cancel_targets_only_that_owner(self):
        api = FakeClient([{"state": "running"}])
        manager = client.QueryManager(api, poll_interval=0.01)
        task = asyncio.create_task(manager.query("a", client.Query("昵称#123")))
        await api.created.wait()
        with self.assertRaises(client.UserError):
            await manager.query("a", client.Query("昵称#123"))
        self.assertFalse(await manager.cancel("b"))
        self.assertTrue(await manager.cancel("a"))
        with self.assertRaises(client.UserError):
            await task
        self.assertEqual(api.creates, 1)
        self.assertTrue(api.cancels)
        self.assertEqual(manager.active, {})

    async def test_player_not_found_reports_actionable_reason_and_does_not_retry(self):
        api=FakeClient([{'state':'failed','message':'未找到可查询玩家'}]);manager=client.QueryManager(api)
        with self.assertRaisesRegex(client.UserError,'核对完整昵称'):
            await manager.query('a',client.Query('Missing#123'))
        self.assertEqual(api.creates,1);self.assertEqual(api.cancels,[])

    async def test_jobs_capture_each_users_client_for_polling_and_cancellation(self):
        original=FakeClient([{'state':'running'}]);other=FakeClient([{'state':'running'}])
        manager=client.QueryManager(original,poll_interval=0.01)
        task=asyncio.create_task(manager.query('b',client.Query('Other#123'),client=other))
        await other.created.wait();await manager.cancel('b')
        with self.assertRaises(client.UserError):await task
        self.assertEqual(original.creates,0);self.assertEqual(original.cancels,[])
        self.assertEqual(other.creates,1);self.assertTrue(other.cancels)

    async def test_timeout_and_handler_cancellation_release_remote_task(self):
        api = FakeClient([{"state": "running"}])
        manager = client.QueryManager(api, poll_interval=0.01)
        manager.timeout = 0.03
        with self.assertRaisesRegex(client.UserError, "超时"):
            await manager.query("a", client.Query("昵称#123"))
        self.assertEqual(api.cancels, ["a" * 64])
        task = asyncio.create_task(manager.query("b", client.Query("昵称#123")))
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(manager.active, {})

    async def test_failed_job_is_terminal_and_missing_analysis_is_not_reported_as_success(self):
        for state in ({"state": "failed"}, {"state": "done", "analysis": None}):
            api = FakeClient([state])
            manager = client.QueryManager(api)
            with self.assertRaises(client.UserError):
                await manager.query("a", client.Query("昵称#123"))
            self.assertEqual(api.cancels, [])


if __name__ == "__main__":
    unittest.main()
