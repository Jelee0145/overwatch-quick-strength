import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEventBatch} from '../../src/events/parser.mjs';
import {eventApi,trackedEventApi} from '../../src/events/source.mjs';
import {card,page} from '../events-fixture.mjs';

const modern=(options={})=>card(options).replaceAll('match-info-header-scoreholder-score','match-info-header-score').replace('match-info-header-scoreholder-upper','match-info-header-scoreholder');
const parse=html=>parseEventBatch(html).matches;

test('legacy and shared Match/Header widgets expose series scores with best-of format',()=>{
 for(const render of [card,modern]){
  const [match]=parse(page('',render({scores:[3,1],finished:true,bestOf:5})));
  assert.deepEqual(match.scores,[3,1]);assert.equal(match.bestOf,5);assert.equal(match.status,'completed');
 }
 const [match]=parse(page('',modern({scores:[4,2],finished:true,bestOf:7}).replace('(Bo7)','Best of 7')));
 assert.deepEqual(match.scores,[4,2]);assert.equal(match.bestOf,7);
});

test('in-progress ticker retains partial series scores without claiming a final result',()=>{
 const [match]=parse(page(modern({scores:[2,1],finished:false}),''));
 assert.deepEqual(match.scores,[2,1]);assert.equal(match.status,'scheduled');
});

test('unknown and placeholder series scores remain null instead of manufactured zeroes',()=>{
 for(const scores of [null,['-','-'],['W','L'],['',''],['?','?']]){
  const [match]=parse(page(modern({scores}),''));assert.deepEqual(match.scores,[null,null]);
 }
 const [explicitZero]=parse(page(modern({scores:[0,0]}),''));
 assert.deepEqual(explicitZero.scores,[0,0],'explicit source zeroes remain source data');
 const [partial]=parse(page(modern({scores:[1,'-']}),''));assert.deepEqual(partial.scores,[1,null]);
});

test('map-level numeric statistics never substitute for absent series scores',()=>{
 const map='<div class="match-summary"><span class="match-info-header-scoreholder-score">12</span><span class="match-info-header-scoreholder-score">8</span></div>';
 const html=card({scores:null}).replace('</div><div class="match-info-tournament-name">','</div>'+map+'<div class="match-info-tournament-name">');
 const [match]=parse(page(html,''));assert.deepEqual(match.scores,[null,null]);
 const [scored]=parse(page(modern({scores:[2,1]}).replace('</div><div class="match-info-tournament-name">','</div>'+map+'<div class="match-info-tournament-name">'),''));
 assert.deepEqual(scored.scores,[2,1]);
});

test('overlapping ticker copies prefer a completed result and do not erase known scores',()=>{
 const live=modern({scores:[2,1]}),done=modern({scores:[3,1],finished:true});
 const [completed]=parse(page(live,done));assert.equal(completed.status,'completed');assert.deepEqual(completed.scores,[3,1]);
 const good=modern({scores:[3,1],finished:true}),empty=modern({scores:null,finished:true});
 for(const recent of [good+empty,empty+good]){
  const matches=parse(page('',recent));assert.equal(matches.length,1);assert.deepEqual(matches[0].scores,[3,1]);
 }
});

test('recent and tracked ticker requests explicitly include ongoing matches and completed results',()=>{
 const source='https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/Asia/Stage_3/Korea/Regular_Season';
 for(const api of [eventApi(),trackedEventApi(source)]){
  const text=new URL(api).searchParams.get('text');
  assert.match(text,/type=upcoming\|upcoming=true\|ongoing=true\|limit=/);
  assert.match(text,/type=recent\|completed=true\|limit=/);
  assert.match(text,/additionalConditions=/);
  assert.equal(new URL(api).searchParams.get('maxage'),'0');
  assert.equal(new URL(api).searchParams.get('smaxage'),'0');
  assert.equal(new URL(api).searchParams.has('_'),false,'no random cache-busting parameter');
 }
});

test('explicit live source flags are respected, but elapsed times, watch links and zero scores are not proof',()=>{
 for(const flag of ['data-status="live"','data-match-status="ongoing"','data-live="true"']){
  const html=modern({scores:[1,0]}).replace('class="match-info"','class="match-info" '+flag);
  const [match]=parse(page(html,''));assert.equal(match.status,'live');assert.deepEqual(match.scores,[1,0]);
  const [finished]=parse(page('',html));assert.equal(finished.status,'completed','recent section overrides a stale live flag');
 }
 const past=modern({scores:[0,0],timestamp:'1700000000'}).replace('</div><div class="match-info-tournament-name">','</div><a class="live" href="https://live.bilibili.com/1">Watch live</a><div class="match-info-tournament-name">');
 assert.equal(parse(page(past,''))[0].status,'scheduled');
});
