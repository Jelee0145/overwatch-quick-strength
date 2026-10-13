import {nameKey,profileKey,playerIdentity} from './cache-records.mjs';
import {Fault,digest,canonical,token} from './security.mjs';
import {upstream,statKeys} from './dashen.mjs';
import './shared/core.js';
import {heroes} from './shared/data.mjs';

const HOUR=3600000, POLICY=2, tagOK=name=>typeof name==='string'&&/^.+#\d+$/.test(name);
const num=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
const text=(v,n=100)=>String(v??'').slice(0,n);
const fresh=(date,ttl)=>{const age=Date.now()-Date.parse(date);return age>=0&&age<ttl;};
const usable=(m,name)=>!!(m?.hasGameData&&m.resourceDataChecked&&m.duration>0&&m.players?.some(p=>p.name===name));
const rankFresh=r=>Array.isArray(r?.rows)&&!r.error&&fresh(r.rankQueriedAt,6*HOUR);
const search=(env,name)=>({name,token:env.DASHEN_TOKEN,roleId:env.DASHEN_ROLE_ID,dts:env.DASHEN_DTS,server:env.DASHEN_SERVER});
function cacheHit(s,type,key){const value=type+'|'+key;if(!s.cacheHits.includes(value))s.cacheHits.push(value);}
function identityProfile(s,key,res){if(key&&res&&(!s.identityProfiles[key]||Date.parse(res.rankQueriedAt)>Date.parse(s.identityProfiles[key].rankQueriedAt||0)))s.identityProfiles[key]=res;}
function requestCache(s,type,keys){
 if(!s.cacheManifest||s.cacheRequest)return !!s.cacheRequest;
 const wanted=new Set(keys),entries=s.cacheManifest.filter(m=>m.type===type&&wanted.has(m.key)&&!s.cacheConsumed[type+'|'+m.key]).slice(0,80);
 if(!entries.length)return false;s.cacheRequest={id:token(),keys:entries.map(m=>({type,key:m.key})),until:Date.now()+15000};s.checkpointRevision++;return true;
}
export function ingestCache(s,entries,complete=true){
 const asked=new Set((s.cacheRequest?.keys||[]).map(m=>m.type+'|'+m.key));
 for(const entry of entries){if(!asked.has(entry.type+'|'+entry.key))continue;const v=entry.value;
  if(entry.type==='match'&&v?.game?.mid===entry.key&&v.owner)storeBattle(s,v,true);
  if(entry.type==='profile'&&v?.res){for(const name of entry.names?.length?entry.names:[v.name]){profile(s,name,v.res);if(v.playerKey)s.identityByName[name]=v.playerKey;}for(const key of v.playerKeys||[v.playerKey])identityProfile(s,key,v.res);}
  if(entry.type==='history'&&v?.name===entry.key){s.historyIndex[entry.key]={...v,matches:v.matches||[]};for(const m of v.matches||[])storeBattle(s,{owner:v.name,game:m},true);}
 }
 if(complete){for(const key of asked){s.cacheConsumed[key]=true;if(!entries.some(e=>e.type+'|'+e.key===key)&&!s.cacheMissing.includes(key))s.cacheMissing.push(key);}s.cacheRequest=null;}s.checkpointRevision++;
}
function rows(v){
 // A successful, empty provider object means no publicly available competitive records.
 // Unknown shapes and failed requests remain errors rather than cacheable empty evidence.
 if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0)return [];
 if(!Array.isArray(v?.guideCountData))throw new Fault('竞技职责列表异常',502);
 return v.guideCountData.slice(0,20).map(r=>({r:text(r.roleType,20),s:r.lastRankInfo?.rankScore??0,n:text(r.lastRankInfo?.rankName,40),d:num(r.lastRankInfo?.rankSubTier),season:''}));
}
function list(v){const a=Array.isArray(v)?v:v?.matchList||v?.recentMatchList;if(!Array.isArray(a))throw new Fault('快速对局列表异常',502);return a.slice(0,100).map(m=>({mid:text(m.matchId),t:num(m.beginTs)||0,ret:[-1,0,1].includes(m.matchRet)?m.matchRet:0,mapGuid:text(m.mapGuid,80)})).filter(m=>m.mid);}
export async function accountScope(env){return digest(canonical([env.DASHEN_SERVER,env.DASHEN_DTS,env.DASHEN_ROLE_ID,env.DASHEN_TOKEN]));}
export function accountRecords(s){return Object.entries(s.tokens).filter(([name])=>tagOK(name)&&fresh(s.tokenTimes[name],HOUR/2)).map(([name,token])=>({name,token,queriedAt:s.tokenTimes[name]})).slice(-500);}
function profile(s,name,res){if(!tagOK(name)||!Array.isArray(res?.rows))return;const old=s.profiles[name];if(!old||Date.parse(res.rankQueriedAt)>Date.parse(old.rankQueriedAt||0))s.profiles[name]=res;}
function touchToken(s,name,token){if(!token)return;s.tokens[name]=token;s.tokenTimes[name]=new Date().toISOString();}
async function detail(v,m,owner,s,env){
 if(!v||!('teammateList' in v||'enemyList' in v))throw new Fault('对局详情异常',502);
 const players=[];
 for(const [key,side] of [['teammateList','T'],['enemyList','E']])for(const p of (v[key]||[]).slice(0,15)){
  const name=nameKey(text(p.name)),ct=p.customerToken;touchToken(s,name,ct);if(ct)s.wanted[ct]=name;
  const hero=text(p.heroGuid,80);if(ct)s.rowTokens[canonical([m.mid,name,hero,side])]=ct;
  players.push({name,side,hero,playerKey:await playerIdentity(env,ct),stats:Object.fromEntries(statKeys.map(k=>[k,num(p[k]??(k==='soloKill'?p.soloKills:null))])),res:s.ranks[ct]||s.profiles[name]||{rows:[]}});
 }
 return {owner,game:{...m,players,hasGameData:true,resourceDataChecked:true,duration:num(v.gameTimeSec),teamScore:num(v.teamScore),opponentScore:num(v.opponentScore),dataQueriedAt:s.now}};
}
// Battle data is shared only when both viewpoints can be established from the roster.
function project(record,owner,listed){
 if(!record||!usable(record.game,owner))return null;
 const sides=new Set(record.game.players.filter(p=>p.name===owner).map(p=>p.side));
 const sourceSides=new Set(record.game.players.filter(p=>p.name===record.owner).map(p=>p.side));
 if(sides.size!==1||sourceSides.size!==1||!sourceSides.has('T'))return null;
 const flip=sides.has('E'),g=structuredClone(record.game);
 if(flip){for(const p of g.players)p.side=p.side==='T'?'E':'T';[g.teamScore,g.opponentScore]=[g.opponentScore,g.teamScore];}
 return {...g,...listed}; // The requesting player's list supplies victory, never the score.
}
function battle(s,mid,owner,listed){for(const record of s.battles[mid]||[]){const game=project(record,owner,listed);if(game)return game;}return null;}
function storeBattle(s,record,generated=false){for(const p of record.game.players||[])if(p.playerKey){s.identityByName[p.name]=p.playerKey;if(rankFresh(p.res))identityProfile(s,p.playerKey,p.res);}const a=s.battles[record.game.mid]||=[];const i=a.findIndex(r=>r.owner===record.owner);if(i<0)a.push(record);else a[i]=record;if(generated)s.generatedBattles[canonical([record.game.mid,record.owner])]=record;}
function patchRanks(s){for(const records of Object.values(s.battles))for(const record of records)for(const p of record.game.players){const ct=s.rowTokens[canonical([record.game.mid,p.name,p.hero,p.side])];const res=s.ranks[ct]||s.identityProfiles[p.playerKey]||s.profiles[p.name];if(res)p.res=res;}}
function historyFresh(h){return !!h&&!h.error&&fresh(h.queriedAt,(h.matches?.length||h.refs?.length)?6*HOUR:900000);}
function cachedHistory(s,name){const h=s.historyIndex[name];if(!historyFresh(h))return null;if(h.refs)h.matches=h.refs.map(m=>battle(s,m.mid,name,m)).filter(Boolean);const matches=(h.matches||[]).filter(m=>!s.excluded.includes(m.mid)&&usable(m,name)).slice(0,2);if((h.matches.length||h.refs?.length)&&!matches.length)return null;return {...h,matches,cached:true};}
function canReference(h,name){return h?.matches?.some(m=>usable(m,name)&&m.players.some(p=>p.name===name&&['kill','death','heroDamage','cure'].some(k=>Number.isFinite(p.stats?.[k]))));}

export function createQuery(tag,limit,prior={matches:[]},accounts=[],options={}){
 tag=nameKey(tag);
 if(!tagOK(tag)||tag.length>80)throw new Fault('请输入完整战网昵称（昵称#编号）');
 const s={supplementOtherMatches:options.supplementOtherMatches!==false,cacheManifest:options.cacheManifest||null,cacheConsumed:{},cacheMissing:[],rankRequests:0,identityProfiles:{},identityByName:{},cacheHits:[],version:2,phase:'account',tag,limit:Math.min(20,Math.max(1,Number(limit)||10)),prior,page:1,listed:{},out:[],mainIndex:{},mainDone:{},wanted:{},rowTokens:{},tokens:{},tokenTimes:{},ranks:{},profiles:{},battles:{},generatedBattles:{},historyIndex:{},actors:{},receipts:{},checkpointRevision:0,minIntervalMs:500,nextStartAt:0,now:new Date().toISOString(),fetched:0,reused:0,rankFetched:0,rankReused:0,historyCalls:0,historyRanks:0,histories:[],historyErrors:0,historyHits:0,requests:0,deduped:0,accountHits:0,concurrency:3};
 for(const a of accounts)if(tagOK(a.name)&&fresh(a.queriedAt,HOUR/2)){s.tokens[a.name]=a.token;s.tokenTimes[a.name]=a.queriedAt;}
 for(const m of prior.matches||[]){s.mainIndex[m.mid]=m;storeBattle(s,{owner:tag,game:m});for(const p of m.players||[])profile(s,p.name,p.res);}
 for(const record of prior.queryCache?.battles||[])if(record?.owner&&record.game?.mid)storeBattle(s,record);
 for(const p of prior.queryCache?.profiles||[])profile(s,p.name,p.res);
 for(const h of prior.recentHistory||[])for(const m of h.matches||[]){storeBattle(s,{owner:h.name,game:m});for(const p of m.players||[])profile(s,p.name,p.res);}
 for(const original of [...(prior.queryCache?.histories||[]),...(prior.recentHistory||[])]){
  const h=structuredClone(original);if(!h.matches){h.matches=(h.refs||[]).map(m=>battle(s,m.mid,h.name,m)).filter(Boolean);if(h.refs?.length&&!h.matches.length)h.error=true;}
  const old=s.historyIndex[h.name];if(!old||Date.parse(h.queriedAt)>=Date.parse(old.queriedAt))s.historyIndex[h.name]=h;
 }
 return s;
}
export function queryCheckpoint(s){const {prior,mainIndex,battles,out,...mutable}=s;return mutable;}
export function restoreQuery(saved,prior){const s={...createQuery(saved.tag,saved.limit,prior),...saved,prior};for(const record of Object.values(s.generatedBattles))storeBattle(s,record);s.out=(s.selected||[]).map(m=>s.mainDone[m.mid]).filter(Boolean);return s;}
export function upgradeQuery(old){const prior={...(old.prior||{}),battletag:old.tag,matches:[...new Map([...(old.prior?.matches||[]),...(old.out||[])].map(m=>[m.mid,m])).values()],recentHistory:[...(old.prior?.recentHistory||[]),...(old.histories||[])]};return createQuery(old.tag,old.limit,prior,Object.entries(old.tokens||{}).map(([name,token])=>({name,token,queriedAt:old.now})));}
function prepareRanks(s){
 const parents=new Map(),rows=s.out.flatMap(m=>m.players.map(p=>({p,ct:s.rowTokens[canonical([m.mid,p.name,p.hero,p.side])]||s.tokens[p.name]})));
 const root=k=>{if(!parents.has(k))parents.set(k,k);const parent=parents.get(k);if(parent!==k)parents.set(k,root(parent));return parents.get(k);};
 const join=(a,b)=>{if(a&&b)parents.set(root(b),root(a));};
 for(const {p,ct} of rows){const name=tagOK(p.name)?'n:'+nameKey(p.name):null,id=p.playerKey||(ct?'ct:'+ct:null);if(name)root(name);if(id)root(id);join(name,id);}
 const targets=new Map();
 for(const {p,ct} of rows){const id=tagOK(p.name)?'n:'+nameKey(p.name):p.playerKey||(ct?'ct:'+ct:null);if(!id)continue;const key=root(id);if(!targets.has(key))targets.set(key,{key,name:p.name,names:[],playerKey:p.playerKey,playerKeys:[],ct});const t=targets.get(key);if(!t.names.includes(p.name))t.names.push(p.name);if(p.playerKey&&!t.playerKeys.includes(p.playerKey))t.playerKeys.push(p.playerKey);}
 s.rankTargets=[...targets.values()];s.rankDone={};s.phase='ranks';
}
function rankUpdate(s,target,res){if(target.ct)s.ranks[target.ct]=res;for(const key of target.playerKeys||[target.playerKey])identityProfile(s,key,res);for(const name of target.names||[target.name]){profile(s,name,res);if(target.playerKey)s.identityByName[name]=target.playerKey;}s.rankDone[target.key]=true;}
async function planHistory(s){
 patchRanks(s);s.out=s.selected.map(m=>({...s.mainDone[m.mid],players:s.mainDone[m.mid].players.map(p=>({...p,res:s.profiles[p.name]||p.res}))}));
 s.excluded=s.out.map(m=>m.mid);
 if(requestCache(s,'history',s.out.flatMap(m=>m.players.filter(p=>p.name!==s.tag).map(p=>nameKey(p.name)))))return;
 const referenceIds=s.out.flatMap(m=>m.players.flatMap(p=>(s.historyIndex[p.name]?.refs||[]).filter(r=>!s.excluded.includes(r.mid)&&!battle(s,r.mid,p.name,r)).map(r=>r.mid)));
 if(requestCache(s,'match',referenceIds))return;
 s.historyInput=await digest(canonical(s.out.map(m=>({mid:m.mid,t:m.t,map:m.mapGuid,ret:m.ret,players:m.players.map(p=>({name:p.name,hero:p.hero,res:p.res}))}))));
 const priorPlan=s.prior.queryCache?.historyPlan;
 if(priorPlan?.version===POLICY&&priorPlan.input===s.historyInput&&priorPlan.until>Date.now()){
  const kept=priorPlan.names.map(name=>cachedHistory(s,name));if(kept.every(Boolean)){s.histories=kept;s.historyHits=kept.length;s.candidates=[];s.reusedPlan=true;s.phase='history-start';return;}
 }
 const groups=[];
 for(const m of [...s.out].sort((a,b)=>b.t-a.t)){
  const picked=m.players.map(p=>globalThis.QS.pick(p,'role',heroes)),known=picked.filter(p=>Number.isFinite(p.score)&&p.status==='known').length;
  if(known>=4&&known/Math.max(1,picked.length)>=.6)continue;
  for(const side of ['T','E']){const players=picked.filter(p=>p.side===side);if(!players.length)continue;groups.push({players,target:Math.ceil(players.length*.6),covered:new Set(players.filter(p=>Number.isFinite(p.score)&&p.status==='known').map(p=>p.name))});}
 }
 // Greedy coverage avoids repeatedly sampling just one team or one latest match.
 const selected=[];
 while(selected.length<12){const names=[...new Set(groups.flatMap(g=>g.players.filter(p=>p.name!==s.tag&&tagOK(p.name)).map(p=>p.name)))].filter(n=>!selected.includes(n)&&(s.supplementOtherMatches||cachedHistory(s,n)));
  const scored=names.map(name=>({name,gain:groups.filter(g=>g.covered.size<g.target&&!g.covered.has(name)&&g.players.some(p=>p.name===name)).length})).filter(p=>p.gain>0).sort((a,b)=>b.gain-a.gain);
  if(!scored.length)break;const name=scored[0].name,old=cachedHistory(s,name);selected.push(name);
  // A fresh, explicitly empty result is reused, but does not count as evidence.
  if(!old||canReference(old,name))for(const g of groups)if(g.players.some(p=>p.name===name))g.covered.add(name);
 }
 s.candidates=selected;for(const name of selected){const old=cachedHistory(s,name);s.actors[name]=old?{...old,phase:'done'}:{name,matches:[],queriedAt:s.now,savedAt:Date.now()/1000,cached:false,phase:'account'};if(old){s.historyHits++;cacheHit(s,'history',name);}}
 s.phase='history-start';
}
async function advance(s){
 if(s.phase==='account'&&s.tokens[s.tag]){s.mainToken=s.tokens[s.tag];s.accountHits++;s.phase='list';}
 if(s.phase==='details'){
  for(const m of s.selected)if(!s.mainDone[m.mid]){const old=battle(s,m.mid,s.tag,m);if(old){s.mainDone[m.mid]=old;s.reused++;cacheHit(s,'match',m.mid);}}
  if(requestCache(s,'match',s.selected.filter(m=>!s.mainDone[m.mid]).map(m=>m.mid)))return;
  if(s.selected.every(m=>s.mainDone[m.mid])){s.out=s.selected.map(m=>s.mainDone[m.mid]);prepareRanks(s);}
 }
 if(s.phase==='ranks'){
  for(const target of s.rankTargets){const res=[...(target.playerKeys||[target.playerKey]).map(key=>s.identityProfiles[key]),...target.names.map(name=>s.profiles[name])].filter(Boolean).sort((a,b)=>Date.parse(b.rankQueriedAt)-Date.parse(a.rankQueriedAt))[0];if(!s.rankDone[target.key]&&rankFresh(res)){rankUpdate(s,target,res);s.rankReused++;cacheHit(s,'profile',target.playerKey||'n:'+target.name);}}
  if(requestCache(s,'profile',s.rankTargets.filter(t=>!s.rankDone[t.key]).flatMap(t=>[...(t.playerKeys||[]),t.playerKey||'n:'+t.name,...(s.cacheManifest||[]).filter(m=>m.type==='profile'&&m.names?.some(n=>(t.names||[t.name]).includes(n))).map(m=>m.key)])))return;
  if(s.rankTargets.every(t=>s.rankDone[t.key]))await planHistory(s);
 }
 if(s.phase==='history-start'){
  for(const name of s.candidates||[]){const h=s.actors[name];if(h.phase==='account'&&s.tokens[name])h.phase='list';
   if(h.phase==='details'){
    if(requestCache(s,'match',h.list.filter(m=>!h.matches.some(g=>g.mid===m.mid)).map(m=>m.mid)))return;
    for(const m of h.list)if(!h.matches.some(g=>g.mid===m.mid)){const g=battle(s,m.mid,name,m);if(g){h.matches.push(g);s.deduped++;}}
    if(h.matches.length>=2||h.list.every(m=>h.matches.some(g=>g.mid===m.mid)||h.bad?.includes(m.mid)))h.phase='done';
   }
  }
  if((s.candidates||[]).every(name=>s.actors[name].phase==='done')){
   if(!s.reusedPlan)s.histories=(s.candidates||[]).map(name=>{const {phase,list,bad,...h}=s.actors[name];return h;});
   const names=[...new Set(s.histories.filter(h=>h.peerSamplingVersion!==POLICY).flatMap(h=>h.matches.flatMap(m=>m.players.map(p=>p.name))))];
   // Reusing the same sampling decision must not spend another 16 lookups on new peers.
   s.historyRankTargets=s.reusedPlan||!s.supplementOtherMatches?[]:names.filter(n=>s.tokens[n]&&!rankFresh(s.profiles[n])&&!s.profiles[n]?.error).slice(0,16).map(name=>({key:name,name,ct:s.tokens[name]}));
   s.historyRankDone={};s.phase='history-ranks';
  }
 }
 if(s.phase==='history-ranks'){
  for(const target of s.historyRankTargets)if(rankFresh(s.profiles[target.name]))s.historyRankDone[target.key]=true;
  if(s.historyRankTargets.every(t=>s.historyRankDone[t.key]))finish(s);
 }
}
function operation(kind,target,path,params,body){return {kind,target,path,params,body,key:kind+':'+(target.key||target.mid||target.name||'main')};}
function operations(s,env){
 if(s.phase==='account')return [operation('account',{name:s.tag},'/searchBnetAccount',null,search(env,s.tag))];
 if(s.phase==='list')return [operation('list',{key:String(s.page)},'/customer/queryMatchList',{token:s.mainToken,gameMode:'leisure',page:s.page,season:''})];
 if(s.phase==='details')return s.selected.filter(m=>!s.mainDone[m.mid]).map(m=>operation('detail',m,'/customer/queryMatchInfo',{token:s.mainToken,matchId:m.mid,season:''}));
 if(s.phase==='ranks'||s.phase==='history-ranks'){
  const hist=s.phase==='history-ranks',done=hist?s.historyRankDone:s.rankDone;
  return (hist?s.historyRankTargets:s.rankTargets).filter(t=>!done[t.key]).map(t=>{
   t.ct||=s.tokens[t.name];return t.ct?operation(hist?'history-rank':'rank',t,'/customer/queryCountInfo',{token:t.ct,gameMode:'sport',season:''}):operation('rank-account',t,'/searchBnetAccount',null,search(env,t.name));
  });
 }
 if(s.phase==='history-start'){
  const ops=[];
  for(const name of s.candidates||[]){const h=s.actors[name];
   if(h.phase==='account')ops.push(operation('history-account',{name},'/searchBnetAccount',null,search(env,name)));
   if(h.phase==='list')ops.push(operation('history-list',{name},'/customer/queryMatchList',{token:s.tokens[name],gameMode:'leisure',page:1,season:''}));
   if(h.phase==='details')for(const m of h.list.filter(m=>!h.matches.some(g=>g.mid===m.mid)&&!h.bad?.includes(m.mid)).slice(0,2-h.matches.length)){
    const duplicate=ops.find(o=>o.kind==='history-detail'&&o.target.mid===m.mid);
    if(duplicate)continue;ops.push(operation('history-detail',{...m,name},'/customer/queryMatchInfo',{token:s.tokens[name],matchId:m.mid,season:''}));
   }
  }
  return ops;
 }
 return [];
}
async function apply(s,o,v,env){const t=o.target;
 if(['account','rank-account','history-account'].includes(o.kind)){
  if(!v?.customerToken)throw new Fault('未找到可查询玩家');touchToken(s,t.name,v.customerToken);
  if(o.kind==='account'){s.mainToken=v.customerToken;s.phase='list';}else if(o.kind==='rank-account')t.ct=v.customerToken;else s.actors[t.name].phase='list';return;
 }
 if(o.kind==='list'){
  const games=list(v);for(const m of games)s.listed[m.mid]=m;
  const priorIndex=s.prior.matchIndex||[];const overlaps=games.some(m=>priorIndex.some(p=>p.mid===m.mid));
  if(Object.keys(s.listed).length<s.limit&&!(overlaps&&new Set([...Object.keys(s.listed),...priorIndex.map(m=>m.mid)]).size>=s.limit)&&games.length&&s.page<5){s.page++;return;}
  const a=new Map(priorIndex.map(m=>[m.mid,m]));for(const [key,value] of Object.values(s.mainIndex).filter(m=>usable(m,s.tag)).map(m=>[m.mid,{mid:m.mid,t:m.t,ret:m.ret,mapGuid:m.mapGuid}]))a.set(key,value);for(const m of Object.values(s.listed))a.set(m.mid,m);
  s.selected=[...a.values()].sort((a,b)=>b.t-a.t).slice(0,s.limit);s.phase='details';return;
 }
 if(o.kind==='detail'){const record=await detail(v,t,s.tag,s,env);storeBattle(s,record,true);s.mainDone[t.mid]=record.game;s.fetched++;return;}
 if(o.kind==='rank'||o.kind==='history-rank'){const res={rows:rows(v),rankQueriedAt:new Date().toISOString()};rankUpdate(s,t,res);if(o.kind==='rank')s.rankFetched++;else{s.historyRankDone[t.key]=true;s.historyRanks++;}return;}
 if(o.kind==='history-list'){const h=s.actors[t.name];h.list=list(v).sort((a,b)=>b.t-a.t).filter(m=>!s.excluded.includes(m.mid)).slice(0,3);h.phase='details';return;}
 if(o.kind==='history-detail'){
  const record=await detail(v,{mid:t.mid,t:t.t,ret:t.ret,mapGuid:t.mapGuid},t.name,s,env);storeBattle(s,record,true);const game=project(record,t.name,{mid:t.mid,t:t.t,ret:t.ret,mapGuid:t.mapGuid});
  if(game)s.actors[t.name].matches.push(game);else{const h=s.actors[t.name];(h.bad||=[]).push(t.mid);h.error=true;s.historyErrors++;}
 }
}
function softFailure(s,o){
 if(o.kind==='rank'||o.kind==='history-rank'||o.kind==='rank-account'){
  const r={rows:[],error:true,rankQueriedAt:s.now};rankUpdate(s,o.target,r);if(s.phase==='history-ranks')s.historyRankDone[o.target.key]=true;else s.rankFetched++;return;
 }
 if(o.kind.startsWith('history-')){const h=s.actors[o.target.name];h.error=true;s.historyErrors++;if(o.kind==='history-detail')(h.bad||=[]).push(o.target.mid);else h.phase='done';return;}
 throw new Fault('对局数据未能完整读取',502);
}
function finish(s){
 patchRanks(s);const main=new Map((s.prior.matches||[]).map(m=>[m.mid,m]));
 for(const m of s.out)main.set(m.mid,{...m,players:m.players.map(p=>({...p,res:s.profiles[p.name]||p.res}))});
 for(const h of s.histories){h.matches=h.matches.map(m=>({...m,players:m.players.map(p=>({...p,res:s.profiles[p.name]||p.res}))}));if(s.supplementOtherMatches&&!h.error)h.peerSamplingVersion=POLICY;}
 const matches=[...main.values()].sort((a,b)=>b.t-a.t).slice(0,50),histories=new Map(Object.entries(s.historyIndex));for(const h of s.histories)histories.set(h.name,h);
 const pool=[...histories.values()].filter(historyFresh).sort((a,b)=>Date.parse(b.queriedAt)-Date.parse(a.queriedAt)).slice(0,24);
 const displayed=new Set([...matches,...s.histories.flatMap(h=>h.matches)].map(m=>m.mid));const cachedBattles=Object.values(s.battles).flat().filter(r=>!displayed.has(r.game.mid)&&pool.some(h=>h.matches.some(m=>m.mid===r.game.mid))).slice(0,24);
 const rankExpires=s.histories.flatMap(h=>h.matches.flatMap(m=>m.players.filter(p=>rankFresh(p.res)).map(p=>Date.parse(p.res.rankQueriedAt)+6*HOUR)));
 const expires=Math.min(Date.now()+6*HOUR,...rankExpires,...s.histories.map(h=>h.error?0:Date.parse(h.queriedAt)+(h.matches.length?6*HOUR:900000)));
 const profileList=Object.entries(s.profiles).filter(([,res])=>rankFresh(res)).map(([name,res])=>({name,res,playerKey:s.identityByName[name]})).sort((a,b)=>Date.parse(b.res.rankQueriedAt)-Date.parse(a.res.rankQueriedAt)).slice(0,500);
 const queryIndexMatches=[...new Map([...(s.prior.matchIndex||[]),...(s.prior.matches||[]),...matches,...Object.values(s.listed)].map(m=>[m.mid,{mid:m.mid,t:m.t,ret:m.ret,mapGuid:m.mapGuid}])).values()].sort((a,b)=>b.t-a.t).slice(0,50);
 const result={queryIndexMatches,schemaVersion:3,battletag:s.tag,source:'网易大神 · 云端增量查询',queriedAt:s.now,used_previous_season_fallback:s.out.some(m=>m.players.some(p=>p.res.previousRows?.length)),matches,recentHistory:s.histories,historyQueriedAt:s.now,
  queryCache:{version:POLICY,profiles:profileList,histories:pool.map(({name,matches,queriedAt,savedAt})=>({name,refs:matches.map(({mid,t,ret,mapGuid})=>({mid,t,ret,mapGuid})),queriedAt,savedAt})),battles:cachedBattles,historyPlan:{version:POLICY,input:s.historyInput,names:s.histories.map(h=>h.name),until:expires}},
  syncStatus:{mode:s.supplementOtherMatches?'slow':'fast',rankRequests:s.rankRequests,cacheMissing:s.cacheMissing.length,historyRequests:s.historyCalls,historyCacheHits:s.historyHits,playerSlots:s.out.reduce((n,m)=>n+m.players.length,0),uniquePlayers:s.rankTargets?.length||0,cacheHitKeys:s.cacheHits,fetchedMatches:s.fetched,reusedMatches:s.reused,totalMatches:s.out.length,listedMatches:Object.keys(s.listed).length,rankFetches:s.rankFetched,rankReuses:s.rankReused,cachedOnly:!s.fetched&&!s.rankFetched&&!s.historyCalls,requests:s.requests,accountCacheHits:s.accountHits,deduplicatedRequests:s.deduped},
  historyStatus:{sampledPlayers:s.candidates?.length||s.histories.length,playersWithGames:s.histories.filter(h=>h.matches.length).length,games:new Set(s.histories.flatMap(h=>h.matches.map(m=>m.mid))).size,cacheHits:s.historyHits,requests:s.historyCalls,requestBudget:64,errors:s.historyErrors,maxPlayers:12,gamesPerPlayer:2}};
 s.result=result;s.phase='done';
}
export function queryProgress(s){const total=s.phase==='details'?s.selected?.length||0:s.phase==='ranks'?s.rankTargets?.length||0:s.phase==='history-ranks'?s.historyRankTargets?.length||0:s.phase.startsWith('history')?s.candidates?.length||0:1;const completed=s.phase==='details'?Object.keys(s.mainDone).length:s.phase==='ranks'?Object.keys(s.rankDone||{}).length:s.phase==='history-ranks'?Object.keys(s.historyRankDone||{}).length:s.phase.startsWith('history')?Object.values(s.actors).filter(h=>h.phase==='done').length:s.phase==='done'?total:0;
 return {phase:s.phase,phaseLabel:({account:'搜索账号',list:'读取对局列表',details:'读取新增对局',ranks:'补充竞技段位','history-start':'补充近期参考','history-ranks':'补充近期段位',done:'查询完成'})[s.phase]||'查询中',completed,total,requests:s.requests||0,cacheHits:(s.reused||0)+(s.rankReused||0)+(s.historyHits||0)+(s.accountHits||0),deduplicatedRequests:s.deduped||0};}
function message(s){const p=queryProgress(s),label=({account:'搜索账号',list:'读取对局列表',details:'读取新增对局',ranks:'补充竞技段位','history-start':'补充近期参考','history-ranks':'补充近期段位',done:'查询完成'})[s.phase]||'查询中';return label+(p.total?' '+p.completed+'/'+p.total:'')+' · 请求 '+p.requests+' · 缓存 '+p.cacheHits;}
export async function queryStep(s,env,call=upstream,options={}){
 // Cached transitions are drained together, not scheduled one alarm per cache hit.
 for(let i=0;i<8&&s.phase!=='done';i++){const before=s.phase;await advance(s);if(before===s.phase)break;}
 if(s.phase==='done'||s.cacheRequest)return message(s);
 if(options.deadline&&Math.max(Date.now(),s.nextStartAt||0)>=options.deadline){s.yielded=true;return message(s);}
 let ops=operations(s,env).slice(0,s.concurrency||3);
 const history=s.phase.startsWith('history');if(history)ops=ops.slice(0,Math.max(0,64-s.historyCalls));
 if(!ops.length&&history){for(const h of Object.values(s.actors))if(h.phase!=='done'){h.phase='done';h.error=true;}s.historyErrors++;s.historyRankTargets=[];s.phase='history-ranks';await advance(s);return message(s);}
 let fatal=null,chain=Promise.resolve(),launches=Promise.resolve();const checkpoint=()=>{chain=chain.then(()=>options.checkpoint?.(s));return chain;};
 await Promise.all(ops.map(async o=>{
  // Serialize only launches, not requests: actual start gaps survive timer delays.
  const ready=launches.then(async()=>{
   const startAt=Math.max(Date.now(),s.nextStartAt||0);
   if(options.deadline&&startAt>=options.deadline){s.yielded=true;return false;}
   while(startAt>Date.now())await new Promise(resolve=>setTimeout(resolve,startAt-Date.now()));
   if(options.deadline&&Date.now()>=options.deadline){s.yielded=true;return false;}
   if(fatal||options.shouldStop&&await options.shouldStop())return false;
   s.nextStartAt=Date.now()+Math.max(0,s.minIntervalMs||0);s.requests++;if(o.kind==='rank')s.rankRequests++;if(history)s.historyCalls++;return true;
  });launches=ready.catch(()=>{});if(!await ready)return;
  try{const v=await call(env,o.path,o.params,o.body);await apply(s,o,v,env);s.receipts[o.key]='done';}
  catch(e){if([429,503,504].includes(e.status)||!o.kind.startsWith('history-')&&!['rank','rank-account'].includes(o.kind)){fatal||=e;}else softFailure(s,o);}
  s.checkpointRevision++;await checkpoint();
 }));await chain;
 if(fatal)throw fatal;
 for(let i=0;i<8&&s.phase!=='done';i++){const before=s.phase;await advance(s);if(before===s.phase)break;}
 s.checkpointRevision++;return message(s);
}
export async function runQuery(s,env,options={}){
 const end=Date.now()+(options.budgetMs??8000);let messageText='';s.yielded=false;if(options.minIntervalMs!==undefined&&options.minIntervalMs!==s.minIntervalMs){s.minIntervalMs=options.minIntervalMs;s.nextStartAt=0;}
 do{if(options.shouldStop&&await options.shouldStop())break;messageText=await queryStep(s,env,options.call||upstream,{...options,deadline:end});await options.checkpoint?.(s);}while(s.phase!=='done'&&!s.cacheRequest&&!s.yielded&&Date.now()<end);
 return messageText||message(s);
}
