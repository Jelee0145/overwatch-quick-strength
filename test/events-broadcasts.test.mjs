import test from 'node:test';
import assert from 'node:assert/strict';
import {broadcastsFor} from '../src/events-broadcasts.mjs';
import {parseEvents} from '../src/events-parser.mjs';
import {card,page} from './events-fixture.mjs';

const owcs=(region,extra={})=>({region,tournament:'OWCS 2026',...extra});

test('verified regional OWCS destinations use the correct official language and platform',()=>{
 const cases=[
  ['中国','bilibili','https://live.bilibili.com/23612045'],
  ['北美','twitch','https://www.twitch.tv/ow_esports'],
  ['EMEA','twitch','https://www.twitch.tv/ow_esports'],
  ['日本','twitch','https://www.twitch.tv/ow_esports_jp'],
  ['太平洋','twitch','https://www.twitch.tv/ow_esports_th'],
  ['韩国','soop','https://www.sooplive.co.kr/station/owesports']
 ];
 for(const [region,platform,url] of cases){
  const result=broadcastsFor(owcs(region));
  assert.equal(result.length,1,region);
  assert.equal(result[0].platform,platform);
  assert.equal(result[0].url,url);
  assert.deepEqual(Object.keys(result[0]).sort(),['id','label','platform','url']);
  assert.ok(result[0].id&&result[0].label);
 }
});

test('international OWCS prioritizes the verified Chinese bilibili broadcast',()=>{
 const result=broadcastsFor(owcs('国际赛'));
 assert.deepEqual(result.map(item=>item.url),['https://live.bilibili.com/23612045','https://www.twitch.tv/ow_esports']);
 assert.equal(new Set(result.map(item=>item.id)).size,result.length);
});

test('parser region and sourceUrl fields identify regional and international OWCS matches',()=>{
 const cases=[
  ['China/Stage_3','中国','bilibili'],
  ['Asia/Stage_3/Korea/Regular_Season','韩国','soop'],
  ['Asia/Stage_3/Japan','日本','twitch'],
  ['Asia/Stage_3/Pacific','太平洋','twitch'],
  ['North_America/Stage_3','北美','twitch'],
  ['EMEA/Stage_3','EMEA','twitch'],
  ['World_Finals','国际赛','bilibili']
 ];
 for(const [suffix,region,platform] of cases){
  const [match]=parseEvents(page(card({path:'Overwatch_Champions_Series/2026/'+suffix,name:'赛事名称'}),''));
  assert.equal(match.region,region);
  assert.equal(broadcastsFor(match)[0].platform,platform);
 }
 const [other]=parseEvents(page(card({path:'Other_Cup/2026/China',name:'OWCS invitational fan cup'}),''),{series:'all'});
 assert.deepEqual(broadcastsFor(other),[]);
});

test('unverified competitions, unknown regions and malformed inputs have no broadcast',()=>{
 for(const match of [undefined,null,0,'OWCS',{},[],owcs('亚洲'),owcs('未标注'),owcs('KR'),owcs('__proto__'),owcs('中国',{tournament:'Other Cup'}),owcs('中国',{tournament:'NOTOWCS'}),owcs('中国',{tournament:42})]){
  assert.deepEqual(broadcastsFor(match),[]);
 }
 for(const tournament of ['Overwatch Champions Series 2026','守望先锋冠军系列赛','2026守望先锋全球冠军赛'])assert.equal(broadcastsFor(owcs('中国',{tournament})).length,1);
});

test('source identity is validated and untrusted URLs cannot become broadcast links',()=>{
 for(const sourceUrl of [
  'javascript:alert(1)','http://liquipedia.net/overwatch/Overwatch_Champions_Series/2026',
  'https://liquipedia.net.evil.test/overwatch/Overwatch_Champions_Series/2026',
  'https://liquipedia.net@evil.test/overwatch/Overwatch_Champions_Series/2026',
  'https://user@liquipedia.net/overwatch/Overwatch_Champions_Series/2026',
  'https://liquipedia.net:8443/overwatch/Overwatch_Champions_Series/2026',
  'https://liquipedia.net/overwatch/Other_Cup/2026',
  'https://liquipedia.net/overwatch/Overwatch_Champions_Series_Fake/2026',
  'https://liquipedia.net/overwatch/Overwatch_Champions_Series/',
  'not a URL',{},42
 ])assert.deepEqual(broadcastsFor(owcs('中国',{sourceUrl})),[],String(sourceUrl));
 const allowlist=new Set(['https://live.bilibili.com/23612045','https://www.twitch.tv/ow_esports','https://www.twitch.tv/ow_esports_jp','https://www.twitch.tv/ow_esports_th','https://www.sooplive.co.kr/station/owesports']);
 for(const region of ['中国','国际赛','北美','EMEA','日本','太平洋','韩国']){
  for(const item of broadcastsFor(owcs(region))){
   assert.ok(allowlist.has(item.url));
   assert.equal(new URL(item.url).protocol,'https:');
  }
 }
});

test('callers cannot mutate subsequent broadcast results or the input',()=>{
 const match=Object.freeze(owcs('国际赛'));
 const first=broadcastsFor(match);first[0].url='https://evil.test';first.pop();
 const next=broadcastsFor(match);
 assert.equal(next.length,2);
 assert.equal(next[0].url,'https://live.bilibili.com/23612045');
});
