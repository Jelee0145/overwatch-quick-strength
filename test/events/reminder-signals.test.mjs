import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completion,
  officialFor,
  previousMatch,
  reminderPhase,
  teamKeys
} from '../../backend/server/reminder-signals.mjs';
import { EventReminders, matchIdentity } from '../../backend/server/event-reminders.mjs';
import { latestStages, normalizeOfficialCn } from '../../backend/src/events/official-cn.mjs';
import { SqliteDatabase } from '../../backend/server/storage.mjs';

const MINUTE = 60000;
const cst = (text) => Date.parse(text + '+08:00');
const iso = (t) => new Date(t).toISOString();
const KOREA =
  'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/Asia/Stage_3/Korea#Regional_Playoffs';
const CHINA =
  'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/China/Stage_3/Regular_Season#GS_Week_3';
function game(sourceUrl, time, a, b, extra = {}) {
  return {
    id: [sourceUrl, iso(time), a, b].join('|'),
    series: 'owcs',
    sourceUrl,
    region: sourceUrl.includes('/China/') ? '中国' : '韩国',
    startsAt: iso(time),
    status: 'scheduled',
    teams: [{ name: a }, { name: b }],
    scores: [null, null],
    bestOf: 7,
    ...extra
  };
}
// stableSince defaults to "unchanged for a long time"; tests override it to model edits.
const phase = (match, sourceMatches, now, official, stableSince = now - 60 * MINUTE) =>
  reminderPhase({
    match,
    observedStartsAt: match.startsAt,
    stableSince,
    verified: true,
    sourceMatches,
    official,
    now
  });

test('2026-11-06 replay: an unfinished previous match blocks the stale 16:00 time', () => {
  const previous = game(KOREA, cst('2026-11-06T14:00'), 'T1', 'ZANSIDE GAMING'),
    ours = game(KOREA, cst('2026-11-06T16:00'), 'Cheeseburger', 'Team Falcons');
  for (const now of [cst('2026-11-06T15:50'), cst('2026-11-06T16:00'), cst('2026-11-06T16:30')]) {
    const value = phase(ours, [previous, ours], now);
    assert.equal(value.phase, 'none');
    assert.equal(value.reason, 'previous-pending');
    assert.deepEqual(value.previous.teams, ['T1', 'ZANSIDE GAMING']);
  }
  // Liquipedia rewrote both times at 16:37 (observed 16:39); the previous match runs at 3:1.
  const moved = game(KOREA, cst('2026-11-06T16:15'), 'T1', 'ZANSIDE GAMING', { scores: [3, 1] }),
    later = game(KOREA, cst('2026-11-06T19:00'), 'Cheeseburger', 'Team Falcons'),
    edited = cst('2026-11-06T16:39');
  assert.equal(
    phase(later, [moved, later], cst('2026-11-06T18:20'), undefined, edited).reason,
    'previous-pending'
  );
  const done = { ...moved, scores: [4, 1], completedSeenAt: cst('2026-11-06T18:40') };
  let value = phase(later, [done, later], cst('2026-11-06T18:40'), undefined, edited);
  assert.equal(value.phase, 'pre');
  assert.equal(value.reason, 'previous-completed');
  value = phase(later, [done, later], cst('2026-11-06T19:00'), undefined, edited);
  assert.equal(value.phase, 'start');
  assert.equal(value.reason, 'scheduled-time');
});

test('2026-11-01 replay: an early previous finish announces a match listed for later', () => {
  const previous = game(CHINA, cst('2026-11-01T17:00'), 'All Gamers', 'Solus Victorem', {
      bestOf: 5,
      scores: [3, 0],
      completedSeenAt: cst('2026-11-01T18:02')
    }),
    ours = game(CHINA, cst('2026-11-01T19:00'), 'Weibo Gaming', 'JD Gaming');
  assert.equal(phase(ours, [previous, ours], cst('2026-11-01T18:03')).reason, 'previous-completed');
  const official = [
    {
      uuid: 'm1',
      time: cst('2026-11-01T19:00'),
      status: 'live',
      teams: ['Weibo Gaming', 'JD Gaming']
    }
  ];
  const value = phase(ours, [previous, ours], cst('2026-11-01T18:31'), official);
  assert.equal(value.phase, 'start');
  assert.equal(value.reason, 'official-live');
});

test('first match and long breaks notify ten minutes early, then at the stable listed time', () => {
  const ours = game(KOREA, cst('2026-11-07T14:00'), 'ZETA DIVISION', 'Crazy Raccoon');
  assert.equal(phase(ours, [ours], cst('2026-11-07T13:49')).reason, 'scheduled');
  assert.equal(phase(ours, [ours], cst('2026-11-07T13:50')).reason, 'scheduled-soon');
  assert.equal(phase(ours, [ours], cst('2026-11-07T14:00')).reason, 'scheduled-time');
  // Changed four minutes ago: hold the start reminder until the new time is stable for ten.
  const changed = cst('2026-11-07T13:56');
  assert.equal(phase(ours, [ours], cst('2026-11-07T14:00'), undefined, changed).phase, 'pre');
  assert.equal(phase(ours, [ours], cst('2026-11-07T14:06'), undefined, changed).phase, 'start');
  assert.equal(phase(ours, [ours], cst('2026-11-07T14:31')).reason, 'expired');
  assert.equal(
    phase({ ...ours, scores: [1, 0] }, [ours], cst('2026-11-07T14:40')).reason,
    'match-started'
  );
  const morning = game(KOREA, cst('2026-11-07T11:00'), 'A', 'B'),
    evening = game(KOREA, cst('2026-11-07T19:00'), 'C', 'D');
  assert.equal(
    phase(evening, [morning, evening], cst('2026-11-07T18:50')).reason,
    'scheduled-soon'
  );
  assert.equal(
    phase(evening, [morning, evening], cst('2026-11-07T19:00')).reason,
    'scheduled-time'
  );
  const close = game(KOREA, cst('2026-11-07T16:15'), 'A', 'B');
  assert.equal(
    phase(evening, [close, evening], cst('2026-11-07T18:50')).reason,
    'previous-pending'
  );
  assert.equal(
    previousMatch([morning, evening], game(KOREA, cst('2026-11-08T14:00'), 'E', 'F')),
    null
  );
  assert.equal(
    phase({ ...evening, status: 'completed' }, [evening], cst('2026-11-07T19:00')).reason,
    'completed'
  );
  assert.equal(
    reminderPhase({ match: evening, observedStartsAt: evening.startsAt, verified: false, now: 0 })
      .reason,
    'unverified'
  );
});

test('official names pair with Liquipedia spellings without merging generic words', () => {
  const same = (a, b) => [...teamKeys(a)].some((key) => teamKeys(b).has(key));
  assert.ok(same({ name: 'OU Gaming', shortName: 'OUG' }, 'Over Ultra Gaming'));
  assert.ok(same({ name: 'Solus Victorem', shortName: 'SV' }, 'SV.CRUSH'));
  assert.ok(same({ name: 'HUNENG Gaming', shortName: 'HNG' }, 'HuNeng Gaming'));
  assert.ok(!same({ name: 'Team Falcons' }, 'Team Benxxn'));
  assert.equal(teamKeys('TBD').size, 0);
  const match = game(CHINA, cst('2026-10-31T21:00'), 'Weibo Gaming', 'OU Gaming');
  match.teams[1].shortName = 'OUG';
  const official = [
    {
      uuid: 'a',
      time: cst('2026-10-31T21:00'),
      status: 'completed',
      teams: ['Over Ultra Gaming', 'Weibo Gaming']
    },
    {
      uuid: 'b',
      time: cst('2026-10-31T19:00'),
      status: 'completed',
      teams: ['JD Gaming', 'SV.CRUSH']
    }
  ];
  assert.equal(officialFor(official, match).uuid, 'a');
  assert.ok(completion(match, official));
  assert.equal(
    officialFor(official, game(KOREA, cst('2026-10-31T21:00'), 'Weibo Gaming', 'OU Gaming')),
    null
  );
});

test('official schedule normalization keeps only state, time and team names', () => {
  assert.deepEqual(
    latestStages({
      season_year_list: [
        { year: '2025', stage_list: [{ comp_type: 'S3' }] },
        {
          year: '2026',
          stage_list: [{ comp_type: 'S1' }, { comp_type: 'S2' }, { comp_type: 'S3' }]
        }
      ]
    }),
    [
      { year: '2026', compType: 'S2' },
      { year: '2026', compType: 'S3' }
    ]
  );
  const value = normalizeOfficialCn({
    team_detail_list: [
      { team_uuid: 'w', team_name: 'Weibo Gaming', member_list: [{ member_name: 'x' }] },
      { team_uuid: 'j', team_name: 'JD Gaming' }
    ],
    match_list: [
      {
        match_uuid: 'm',
        match_time: 1,
        status: 2,
        home_team_info: { team_uuid: 'w', team_score: 1 },
        custom_team_info: { team_uuid: 'j', team_score: 0 }
      },
      { match_uuid: 'bad', match_time: 1, status: 9 }
    ]
  });
  assert.deepEqual(value, [
    { uuid: 'm', time: 1, status: 'live', teams: ['Weibo Gaming', 'JD Gaming'], scores: [1, 0] }
  ]);
});

test('tracking exposes the combined phase and refreshes China state once per minute', async () => {
  const db = new SqliteDatabase(':memory:');
  let now = cst('2026-11-01T18:00');
  const previous = game(CHINA, cst('2026-11-01T17:00'), 'All Gamers', 'Solus Victorem', {
      bestOf: 5
    }),
    ours = game(CHINA, cst('2026-11-01T19:00'), 'Weibo Gaming', 'JD Gaming');
  let source = [previous, ours],
    officialStatus = 0,
    officialCalls = 0;
  const env = {
    PUBLIC_ORIGIN: 'https://owqs.test',
    EVENTS: { get: () => ({ fetch: async () => Response.json({ matches: source }) }) },
    OFFICIAL_CN_FETCH: async (url) => {
      officialCalls++;
      return Response.json(
        url.includes('stage_list')
          ? {
              code: 0,
              data: { season_year_list: [{ year: '2026', stage_list: [{ comp_type: 'S3' }] }] }
            }
          : {
              code: 0,
              data: {
                team_detail_list: [
                  { team_uuid: 'w', team_name: 'Weibo Gaming' },
                  { team_uuid: 'j', team_name: 'JD Gaming' }
                ],
                match_list: [
                  {
                    match_uuid: 'm',
                    match_time: cst('2026-11-01T19:00'),
                    status: officialStatus,
                    home_team_info: { team_uuid: 'w', team_score: 0 },
                    custom_team_info: { team_uuid: 'j', team_score: 0 }
                  }
                ]
              }
            }
      );
    }
  };
  const service = new EventReminders(db.store('reminders'), env, { now: () => now });
  const id = matchIdentity(ours),
    sync = async () => (await service.syncTracking('bot', { matchIds: [id] })).matches[0];
  try {
    await service.decorate(source);
    await sync();
    await service.alarm();
    let item = await sync();
    assert.equal(item.reminder.reason, 'previous-pending');
    assert.equal(officialCalls, 2);
    await service.alarm();
    assert.equal(officialCalls, 2, 'official state is shared and rate limited');
    now += 2 * MINUTE;
    source = [{ ...previous, scores: [3, 0] }, ours];
    await service.alarm();
    item = await sync();
    assert.equal(item.reminder.phase, 'pre');
    assert.equal(item.reminder.reason, 'previous-completed');
    assert.equal(item.reminder.previous.completed, true);
    now += 2 * MINUTE;
    officialStatus = 2;
    await service.alarm();
    item = await sync();
    assert.equal(item.reminder.reason, 'official-live');
    assert.equal(item.canNotify, false, 'legacy clients keep the listed-time rule');
  } finally {
    await db.close();
  }
});

test('a finished previous match seen on first observation never claims a fresh finish', async () => {
  const db = new SqliteDatabase(':memory:');
  const now = cst('2026-11-01T18:30');
  const previous = game(CHINA, cst('2026-11-01T17:00'), 'All Gamers', 'Solus Victorem', {
      bestOf: 5,
      scores: [3, 0]
    }),
    ours = game(CHINA, cst('2026-11-01T19:00'), 'Weibo Gaming', 'JD Gaming');
  const env = {
    EVENTS: { get: () => ({ fetch: async () => Response.json({ matches: [previous, ours] }) }) }
  };
  const service = new EventReminders(db.store('reminders'), env, { now: () => now });
  try {
    await service.decorate([previous, ours]);
    await service.syncTracking('bot', { matchIds: [matchIdentity(ours)] });
    await service.alarm();
    const state = await db.store('reminders').get('state');
    assert.equal(state.sources[CHINA].matches[0].completedSeenAt, 0);
    const item = (await service.syncTracking('bot', { matchIds: [matchIdentity(ours)] }))
      .matches[0];
    assert.equal(
      item.reminder.phase,
      'pre',
      'previous is done; within one hour of the listed time'
    );
  } finally {
    await db.close();
  }
});
