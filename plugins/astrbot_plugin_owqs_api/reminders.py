"""Persistent, session-scoped event reminders backed by server schedule tracking."""
import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone

from .api_client import UserError, owner_key

DAY = 86400


def match_label(match):
    teams = match.get('teams') or []
    names = [str(team.get('name') or '待定').replace('\n', ' ')[:60] for team in teams[:2]]
    return ' 对 '.join(names) if len(names) == 2 else '赛事'


def match_time(match):
    try:
        return datetime.fromisoformat(match['startsAt'].replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M')
    except (KeyError, ValueError, TypeError, AttributeError):
        return '时间待定'


class EventReminderManager:
    def __init__(self, plugin):
        self.plugin = plugin
        self.db = plugin.bindings.db
        self.wake = asyncio.Event()
        self.task = None
        self.lock = asyncio.Lock()
        self.backoff = {}
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS event_selection (
                owner TEXT NOT NULL, origin TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL,
                PRIMARY KEY(owner, origin));
            CREATE TABLE IF NOT EXISTS event_reservations (
                owner TEXT NOT NULL, origin TEXT NOT NULL, match_id TEXT NOT NULL,
                match TEXT NOT NULL, created REAL NOT NULL, state TEXT NOT NULL,
                revision INTEGER, reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0, PRIMARY KEY(owner, origin, match_id));
        ''')

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.run())

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None

    def remember(self, event, value):
        owner, origin = owner_key(event), event.unified_msg_origin
        if value.get('state') == 'pending':
            with self.db:
                self.db.execute('DELETE FROM event_selection WHERE owner=? AND origin=?', (owner, origin))
            return
        matches = (value.get('matches') or [])[:20]
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO event_selection VALUES(?,?,?,?)',
                            (owner, origin, json.dumps(matches, ensure_ascii=False), time.time()))

    def has_selection(self, event):
        row = self.db.execute('SELECT created FROM event_selection WHERE owner=? AND origin=?',
                              (owner_key(event), event.unified_msg_origin)).fetchone()
        return bool(row and time.time() - row[0] <= 3600)

    def selected(self, event, index):
        if isinstance(index, bool) or not re.fullmatch(r'[0-9]+(?:\.0+)?', str(index)):
            raise UserError('请提供赛程中的比赛编号')
        index = int(float(index))
        row = self.db.execute('SELECT payload,created FROM event_selection WHERE owner=? AND origin=?',
                              (owner_key(event), event.unified_msg_origin)).fetchone()
        if not row or time.time() - row[1] > 3600:
            raise UserError('请先在当前对话查询赛程，再选择其中的比赛')
        matches = json.loads(row[0])
        if not 1 <= index <= len(matches):
            raise UserError('比赛编号不在当前赛程结果中，请重新选择')
        match = matches[index - 1]
        if not match.get('reservable') or not re.fullmatch(r'[a-f0-9]{64}', str(match.get('reminderId') or '')):
            raise UserError('这场比赛暂不支持预约，可能是队伍待定、重复对阵或赛事来源不支持')
        return match

    async def reserve(self, event, index):
        owner, origin = owner_key(event), event.unified_msg_origin
        match = self.selected(event, index)
        match_id = match['reminderId']
        async with self.lock:
            existing = self.db.execute('SELECT state FROM event_reservations WHERE owner=? AND origin=? AND match_id=?',
                                       (owner, origin, match_id)).fetchone()
            if existing and existing[0] == 'watching':
                return '这场比赛已经在当前对话预约，开赛时间变化会自动同步。'
            if existing and existing[0] == 'sent':
                raise UserError('这场比赛已经提醒过；如确需再次预约，请先取消旧提醒并重新查询赛程。')
            count = self.db.execute("SELECT count(*) FROM event_reservations WHERE owner=? AND state='watching'", (owner,)).fetchone()[0]
            if count >= 100:
                raise UserError('最多保留 100 场赛事提醒，请先取消不需要的预约')
            client, _, free = self.plugin.route(owner)
            if free and (await client.account()).get('tier') != 'free':
                raise UserError('免费服务配置错误，请管理员配置独立 free 层级的 free_api_key')
            result = await client.track_events([match_id])
            items = result.get('matches') or []
            item = next((item for item in items if item.get('id') == match_id), None)
            if not item or item.get('trackingState') in ('missing', 'ambiguous', 'completed', 'expired'):
                raise UserError('这场比赛暂时无法确认或不支持预约，请刷新赛程后重试')
            match = item.get('match') or match
            with self.db:
                self.db.execute('INSERT OR REPLACE INTO event_reservations VALUES(?,?,?,?,?,?,?,?,?,?)',
                                (owner, origin, match_id, json.dumps(match, ensure_ascii=False), time.time(),
                                 'watching', item.get('scheduleRevision'), '', 0, 0))
        self.wake.set()
        pending = '目前正在核实赛程。' if item.get('trackingState') == 'unverified' else ''
        return f'已在当前对话预约 {match_label(match)}（{match_time(match)} 北京时间）。{pending}开赛时间稳定十分钟后按最新公布时间提醒；若时间变动会自动跟随。'

    def listing(self, event):
        rows = self.db.execute('SELECT match,state,reason FROM event_reservations WHERE owner=? AND origin=? ORDER BY created',
                               (owner_key(event), event.unified_msg_origin)).fetchall()
        if not rows:
            return '当前对话没有赛事提醒预约。'
        labels = {'watching': '跟踪中', 'sent': '已提醒', 'completed': '比赛已结束', 'expired': '已过期'}
        lines = ['当前对话的赛事提醒：']
        for index, (payload, state, reason) in enumerate(rows, 1):
            match = json.loads(payload)
            lines.append(f'{index}. {match_label(match)} · {match_time(match)} · {labels.get(state, state)}' + (f'（{reason}）' if reason else ''))
        return '\n'.join(lines)

    async def cancel(self, event, index):
        if isinstance(index, bool) or not re.fullmatch(r'[0-9]+(?:\.0+)?', str(index)):
            raise UserError('请提供提醒列表中的编号')
        async with self.lock:
            owner, origin = owner_key(event), event.unified_msg_origin
            rows = self.db.execute('SELECT match_id,match FROM event_reservations WHERE owner=? AND origin=? ORDER BY created', (owner, origin)).fetchall()
            index = int(float(index))
            if not 1 <= index <= len(rows):
                raise UserError('提醒编号不存在，请先查看提醒列表')
            match_id, payload = rows[index - 1]
            with self.db:
                self.db.execute('DELETE FROM event_reservations WHERE owner=? AND origin=? AND match_id=?', (owner, origin, match_id))
        self.wake.set()
        return f'已取消当前对话中 {match_label(json.loads(payload))} 的提醒。'

    async def run(self):
        while True:
            self.wake.clear()
            try:
                await self.sync()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Keep reservations for a later retry; never log credentials or message origins.
                from astrbot.api import logger
                logger.warning('OWQS 赛事提醒同步失败，将稍后重试')
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=20)
            except asyncio.TimeoutError:
                pass

    async def sync(self):
        async with self.lock:
            now = time.time()
            with self.db:
                for owner, origin, match_id, payload, created in self.db.execute(
                    "SELECT owner,origin,match_id,match,created FROM event_reservations WHERE state='watching' AND created<?",
                    (now - 14 * DAY,)).fetchall():
                    try:
                        start = datetime.fromisoformat(json.loads(payload).get('startsAt', '').replace('Z', '+00:00')).timestamp()
                    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
                        start = None
                    if start is None and created < now - 60 * DAY:
                        self.db.execute("UPDATE event_reservations SET state='expired',reason='赛事时间长期待定' WHERE owner=? AND origin=? AND match_id=?", (owner, origin, match_id))
            rows = self.db.execute("SELECT owner,origin,match_id,match,attempts,retry_at FROM event_reservations WHERE state='watching' ORDER BY created").fetchall()
            groups = {}
            for row in rows:
                try:
                    client, scope, _ = self.plugin.route(row[0])
                    groups.setdefault(scope, [client, []])[1].append(row)
                except UserError:
                    with self.db:
                        self.db.execute("UPDATE event_reservations SET reason='网站账号不可用' WHERE owner=? AND origin=? AND match_id=?", row[:3])
            for scope, (client, group) in groups.items():
                if now < self.backoff.get(scope, 0):
                    continue
                ids = list(dict.fromkeys(row[2] for row in group))
                values = {}
                try:
                    for start in range(0, len(ids), 50):
                        result = await client.track_events(ids[start:start + 50])
                        values.update({item['id']: item for item in result.get('matches', []) if item.get('id')})
                except UserError as error:
                    self.backoff[scope] = now + getattr(error, 'retry_after', 20)
                    with self.db:
                        for row in group:
                            self.db.execute("UPDATE event_reservations SET reason='赛程同步暂不可用' WHERE owner=? AND origin=? AND match_id=?", row[:3])
                    continue
                for owner, origin, match_id, payload, attempts, retry_at in group:
                    item = values.get(match_id)
                    if not item:
                        continue
                    status = item.get('trackingState', 'unverified')
                    match = item.get('match') or json.loads(payload)
                    reason = {'unverified': '等待赛程核实', 'missing': '赛程暂缺', 'ambiguous': '对阵存在歧义'}.get(status, '')
                    if status == 'expired':
                        reason = '已错过本次提醒窗口，继续跟踪改期'
                    state = 'completed' if status == 'completed' else 'watching'
                    with self.db:
                        self.db.execute('UPDATE event_reservations SET match=?,revision=?,state=?,reason=? WHERE owner=? AND origin=? AND match_id=?',
                                        (json.dumps(match, ensure_ascii=False), item.get('scheduleRevision'), state, reason, owner, origin, match_id))
                    if state != 'watching' or not item.get('canNotify') or now < retry_at:
                        continue
                    url = next((b.get('url') for b in (match.get('broadcasts') or []) if b.get('url')), '')
                    message = f'你预约的 {match_label(match)} 已到当前公布的开赛时间（{match_time(match)} 北京时间）。'
                    if url:
                        message += '\n观看：' + str(url)
                    sent = await self.plugin.notify(origin, message)
                    with self.db:
                        if sent:
                            self.db.execute("UPDATE event_reservations SET state='sent',reason='' WHERE owner=? AND origin=? AND match_id=? AND state='watching'", (owner, origin, match_id))
                        else:
                            self.db.execute("UPDATE event_reservations SET attempts=?,retry_at=?,reason='发送失败，稍后重试' WHERE owner=? AND origin=? AND match_id=? AND state='watching'", (attempts + 1, now + min(120, 15 * (2 ** min(attempts, 3))), owner, origin, match_id))
