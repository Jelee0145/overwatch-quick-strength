import test from 'node:test';import assert from 'node:assert/strict';
import {canonical,signSnapshot,verifySnapshot} from '../src/security.mjs';
import {mintCacheRecords,verifyCacheRecord} from '../src/query/cache-records.mjs';
test('missing provider identities survive JSON transport for snapshots and individual cache records',async()=>{
 const env={CACHE_SIGNING_KEY:'transport-test-only',DASHEN_SERVER:'1',DASHEN_DTS:'2026'},player={name:'Example#100',playerKey:undefined,res:{rows:[],rankQueriedAt:new Date().toISOString()}},data={battletag:'Example#100',queriedAt:new Date().toISOString(),matches:[{mid:'9007199254740993001',t:1,mapGuid:'map',ret:1,players:[player]}]};
 const roundTrip=v=>JSON.parse(JSON.stringify(v)),snapshot=roundTrip(await signSnapshot('u',data,env));
 assert.equal((await verifySnapshot(snapshot,'u',env,data.battletag)).matches[0].players[0].name,player.name);
 const records=roundTrip(await mintCacheRecords('u',data,env));assert.ok(records.some(r=>r.content.type==='profile'));for(const r of records)await verifyCacheRecord(r,'u',env);
 snapshot.content.data.matches[0].ret=-1;await assert.rejects(()=>verifySnapshot(snapshot,'u',env,data.battletag));
 assert.equal(canonical({x:undefined,a:[undefined,,NaN],n:null}),canonical(roundTrip({x:undefined,a:[undefined,,NaN],n:null})));
});
