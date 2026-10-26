import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  get,
  mask,
  otherPlayers,
  participants
} from '../../scripts/diagnostics/dashen-player-probe.mjs';

const credential = {
  DASHEN_ROLE_ID: '12345',
  DASHEN_TOKEN: 'a'.repeat(32),
  DASHEN_DTS: '2026',
  DASHEN_SERVER: '1'
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('a detail exposes one customerToken per participant, on both sides', () => {
  const rows = participants({
    teammateList: [
      { name: 'T1#100', customerToken: 'ct-t1' },
      { name: 'T2#100', customerToken: 'ct-t2' }
    ],
    enemyList: [{ name: 'E1#100', customerToken: 'ct-e1' }, { name: 'no-token#100' }]
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.side]),
    [
      ['T1#100', 'T'],
      ['T2#100', 'T'],
      ['E1#100', 'E']
    ]
  );
  // Players without a token are dropped rather than carried as empty entries.
  assert.equal(rows.length, 3);
});

test("the caller's own token is separated from other players", () => {
  const rows = [
    { name: 'Me#100', side: 'T', token: 'own' },
    { name: 'Other#200', side: 'E', token: 'other' }
  ];
  const others = otherPlayers(rows, 'own');
  assert.deepEqual(
    others.map((row) => row.name),
    ['Other#200']
  );
  assert.equal(otherPlayers(rows, 'none').length, 2);
});

test('profile and list responses are unwrapped like the production adapter', async () => {
  const seen = [];
  const card = await get(
    credential,
    '/customer/queryCard',
    { token: 'ct' },
    {
      fetcher: async (url, init) => {
        seen.push({ url: String(url), init });
        return reply({ code: 0, data: { name: 'Other#200', customerToken: 'ct2' } });
      }
    }
  );
  assert.equal(card.verdict, 'ok');
  assert.equal(card.value.name, 'Other#200');
  assert.equal(seen[0].init.method, 'GET');
  // Tokens stay in the query string and headers, never in the credential's printed summary.
  assert.ok(!JSON.stringify(card).includes(credential.DASHEN_TOKEN));
  // A nested data wrapper is unwrapped too, matching the adapter's three-level walk.
  const nested = await get(
    credential,
    '/queryCard',
    {},
    {
      fetcher: async () => reply({ code: 0, data: { data: { name: 'Deep#300' } } })
    }
  );
  assert.equal(nested.value.name, 'Deep#300');
});

test('empty and rejected responses stay distinguishable for other players', async () => {
  const empty = await get(
    credential,
    '/customer/queryCard',
    { token: 'ct' },
    {
      fetcher: async () => reply({ code: 0, success: true })
    }
  );
  assert.equal(empty.verdict, 'empty-success');
  assert.equal(empty.ok, false);
  const rejected = await get(
    credential,
    '/customer/queryMatchList',
    { token: 'bad' },
    {
      fetcher: async () => reply({ code: 401, errMsg: 'Token Invalid' }, 401)
    }
  );
  assert.equal(rejected.verdict, 'credential-rejected');
});

test('names are masked so reports never echo a full battle tag', () => {
  assert.equal(mask('daze#51307'), 'd***#51307');
  assert.equal(mask('三岁辉夜暴力炸金#5934'), '三***#5934');
  assert.equal(mask('not-a-tag'), 'not-a-tag');
});
