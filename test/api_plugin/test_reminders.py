import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = 'owqs_reminder_test'
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / 'plugins/astrbot_plugin_owqs_api')]
sys.modules[PACKAGE] = package
api = importlib.import_module(PACKAGE + '.api_client')
reminders = importlib.import_module(PACKAGE + '.reminders')


def event(user='user', origin='test:GroupMessage:group'):
    return types.SimpleNamespace(get_platform_id=lambda: 'test', get_self_id=lambda: 'bot',
                                 get_sender_id=lambda: user, unified_msg_origin=origin)


def match():
    return {'reminderId': 'a' * 64, 'reservable': True, 'startsAt': '2026-10-30T12:00:00Z',
            'teams': [{'name': 'A'}, {'name': 'B'}], 'status': 'scheduled'}


class ReminderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = api.Bindings(self.temp.name)
        self.client = types.SimpleNamespace(account=AsyncMock(return_value={'tier': 'free'}), track_events=AsyncMock())
        self.plugin = types.SimpleNamespace(bindings=self.store, route=lambda owner: (self.client, 'free:shared', True), notify=AsyncMock(return_value=True))
        self.manager = reminders.EventReminderManager(self.plugin)
        self.current = {'id': 'a' * 64, 'trackingState': 'watching', 'match': match(), 'scheduleRevision': 1, 'canNotify': False}
        self.client.track_events.side_effect = lambda ids: {'matches': [self.current]}
        self.event = event()
        self.manager.remember(self.event, {'matches': [match()]})

    async def asyncTearDown(self):
        await self.manager.close()
        self.store.close()
        self.temp.cleanup()

    async def test_reservation_persists_and_notifies_original_session_once(self):
        self.assertIn('已在当前对话预约', await self.manager.reserve(self.event, 1))
        self.assertIn('已经', await self.manager.reserve(self.event, 1))
        await self.manager.sync()
        self.plugin.notify.assert_not_awaited()
        changed = {**match(), 'startsAt': '2026-10-30T13:00:00Z'}
        self.current.update(match=changed, scheduleRevision=2, canNotify=True)
        self.store.close()
        self.store = api.Bindings(self.temp.name)
        self.plugin.bindings = self.store
        self.manager = reminders.EventReminderManager(self.plugin)
        await self.manager.sync()
        self.plugin.notify.assert_awaited_once()
        origin, text = self.plugin.notify.await_args.args
        self.assertEqual(origin, self.event.unified_msg_origin)
        self.assertIn('21:00', text)
        await self.manager.sync()
        self.plugin.notify.assert_awaited_once()
        with self.assertRaises(api.UserError):
            await self.manager.reserve(self.event, 1)

    async def test_selection_and_cancellation_are_per_owner_and_conversation(self):
        await self.manager.reserve(self.event, 1)
        other = event('other')
        with self.assertRaises(api.UserError):
            await self.manager.cancel(other, 1)
        different = event(origin='test:FriendMessage:user')
        with self.assertRaises(api.UserError):
            await self.manager.reserve(different, 1)
        self.manager.remember(different, {'matches': [match()]})
        await self.manager.reserve(different, 1)
        await self.manager.cancel(self.event, 1)
        self.assertIn('没有', self.manager.listing(self.event))
        self.assertIn('跟踪中', self.manager.listing(different))

    async def test_failure_retries_without_claiming_success(self):
        await self.manager.reserve(self.event, 1)
        self.current['canNotify'] = True
        self.plugin.notify.return_value = False
        await self.manager.sync()
        self.assertIn('发送失败', self.manager.listing(self.event))
        await self.manager.sync()
        self.plugin.notify.assert_awaited_once()

    async def test_old_reservation_and_missed_window_still_follow_postponement(self):
        await self.manager.reserve(self.event, 1)
        with self.store.db:
            self.store.db.execute('UPDATE event_reservations SET created=?', (reminders.time.time() - 15 * reminders.DAY,))
        self.current.update(trackingState='expired', canNotify=False)
        await self.manager.sync()
        self.assertIn('继续跟踪改期', self.manager.listing(self.event))
        self.current.update(trackingState='watching', scheduleRevision=2, canNotify=True)
        await self.manager.sync()
        self.plugin.notify.assert_awaited_once()

    async def test_pending_query_invalidates_previous_selection(self):
        self.manager.remember(self.event, {'state': 'pending'})
        with self.assertRaises(api.UserError):
            await self.manager.reserve(self.event, 1)

    async def test_failed_tracking_does_not_create_reservation(self):
        self.client.track_events.side_effect = api.UserError('服务不可用')
        with self.assertRaises(api.UserError):
            await self.manager.reserve(self.event, 1)
        self.assertIn('没有', self.manager.listing(self.event))
