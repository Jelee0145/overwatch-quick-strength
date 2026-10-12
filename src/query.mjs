import {Fault} from './security.mjs';
export const statKeys=['kill','assist','death','heroDamage','cure','resistDamage','finalHit','soloKill','targetCompetingTime','healingTaken','damageTaken'];
const num=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
const text=(v,n=100)=>String(v??'').slice(0,n);
export function unwrap(v){for(let i=0;i<3&&v&&typeof v==='object'&&!Array.isArray(v)&&v.data&&!['guideCountData','teammateList','matchId'].some(k=>k in v);i++)v=v.data;return v;}
export async function upstream(env,path,params,body,fetcher=fetch){
 if(!env.DASHEN_TOKEN||!env.DASHEN_ROLE_ID)throw new Fault('查询凭证尚未配置，请联系管理员',503);
 const url=new URL('https://datamsapi.ds.163.com/v1/a19ld5tool'+path);for(const [k,v] of Object.entries(params||{}))if(v!==''&&v!==null&&v!==undefined)url.searchParams.set(k,v);
 const headers={'Accept':'application/json','GL-Bigdata-Role-Id':env.DASHEN_ROLE_ID,'GL-Bigdata-Auth-Token':env.DASHEN_TOKEN,'GL-Bigdata-Dts':env.DASHEN_DTS,'GL-Bigdata-Server':env.DASHEN_SERVER,'GL-ClientType':'60','Origin':'https://act.ds.163.com','Referer':'https://act.ds.163.com/','User-Agent':'Mozilla/5.0 (Windows NT 10.0; WOW64) app/df_client dfVersion/100111'};
 if(body)headers['Content-Type']='application/json;charset=UTF-8';let r;
 try{r=await fetcher(url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000),redirect:'error'});}catch{throw new Fault('大神请求超时或网络不可用',504);}
 if([401,403].includes(r.status))throw new Fault('大神凭证已失效，请联系管理员更新',503);
 if(r.status===429)throw new Fault('大神接口限流，当前任务已暂停，稍后继续',429);
 if(!r.ok)throw new Fault('大神接口暂不可用（HTTP '+r.status+'）',502);
 let v;try{v=await r.json();}catch{throw new Fault('大神返回格式异常',502);}
 if([401,403].includes(v.code))throw new Fault('大神凭证已失效，请联系管理员更新',503);
 if(v.code===429)throw new Fault('大神接口限流，当前任务已暂停，稍后继续',429);
 if(![0,200].includes(v.code)||v.success===false)throw new Fault('大神返回业务错误（'+text(v.code,20)+'）',502);return unwrap(v.data);
}
const search=(env,name)=>({name,token:env.DASHEN_TOKEN,roleId:env.DASHEN_ROLE_ID,dts:env.DASHEN_DTS,server:env.DASHEN_SERVER});
function rows(v){if(!v||!Array.isArray(v.guideCountData))throw new Fault('竞技职责列表异常',502);return v.guideCountData.slice(0,20).map(r=>({r:text(r.roleType,20),s:r.lastRankInfo?.rankScore??0,n:text(r.lastRankInfo?.rankName,40),d:num(r.lastRankInfo?.rankSubTier),season:''}));}
function list(v){const x=Array.isArray(v)?v:v?.matchList||v?.recentMatchList;if(!Array.isArray(x))throw new Fault('快速对局列表异常',502);return x.slice(0,100).map(m=>({mid:text(m.matchId),t:num(m.beginTs)||0,ret:[-1,0,1].includes(m.matchRet)?m.matchRet:0,mapGuid:text(m.mapGuid,80)})).filter(m=>m.mid);}
function detail(v,m,s){if(!v||!('teammateList' in v||'enemyList' in v))throw new Fault('对局详情异常',502);
 const players=[];for(const [key,side] of [['teammateList','T'],['enemyList','E']])for(const p of (v[key]||[]).slice(0,15)){
  const ct=p.customerToken,name=text(p.name);if(ct){s.tokens[name]=ct;s.wanted[ct]=name;}
  players.push({name,side,hero:text(p.heroGuid,80),stats:Object.fromEntries(statKeys.map(k=>[k,num(p[k]??(k==='soloKill'?p.soloKills:null))])),res:s.ranks[ct]||{rows:[]}});
 }
 return {...m,players,hasGameData:true,resourceDataChecked:true,duration:num(v.gameTimeSec),teamScore:num(v.teamScore),opponentScore:num(v.opponentScore),dataQueriedAt:s.now};
}
const usable=(m,tag)=>m&&m.resourceDataChecked&&m.duration>0&&m.players.some(p=>p.name===tag);
export function createQuery(tag,limit,prior={matches:[]}){
 if(typeof tag!=='string'||tag.length>80||!/^.+#\d+$/.test(tag))throw new Fault('请输入完整战网昵称（昵称#编号）');
 return {phase:'account',tag,limit:Math.min(20,Math.max(1,Number(limit)||10)),prior,page:1,listed:{},out:[],wanted:{},tokens:{},ranks:{},index:0,now:new Date().toISOString(),fetched:0,reused:0,rankFetched:0,rankReused:0,historyCalls:0,historyRanks:0,histories:[],historyErrors:0,historyHits:0};
}
function beginHistory(s){const excluded=new Set(s.out.map(m=>m.mid)),groups=[];for(const m of [...s.out].sort((a,b)=>b.t-a.t))for(const side of ['T','E'])groups.push(m.players.filter(p=>p.side===side&&p.name!==s.tag).sort((a,b)=>!!a.res.rows.length-!!b.res.rows.length));const candidates=[];for(let i=0;i<5;i++)for(const g of groups)if(g[i]?.name.includes('#')&&!candidates.includes(g[i].name))candidates.push(g[i].name);s.candidates=candidates.slice(0,12);s.excluded=[...excluded];s.index=0;s.phase='history-start';}
function finish(s){
 const selected=new Map((s.prior.matches||[]).map(m=>[m.mid,m]));for(const m of s.out)selected.set(m.mid,m);
 const result={schemaVersion:1,battletag:s.tag,source:'网易大神 · 云端增量查询',queriedAt:s.now,used_previous_season_fallback:s.out.some(m=>m.players.some(p=>p.res.previousRows?.length)),matches:[...selected.values()].sort((a,b)=>b.t-a.t).slice(0,50),recentHistory:s.histories,historyQueriedAt:s.now,
 syncStatus:{fetchedMatches:s.fetched,reusedMatches:s.reused,totalMatches:s.out.length,listedMatches:Object.keys(s.listed).length,rankFetches:s.rankFetched,rankReuses:s.rankReused,cachedOnly:false},
 historyStatus:{sampledPlayers:s.candidates.length,playersWithGames:s.histories.filter(h=>h.matches.length).length,games:new Set(s.histories.flatMap(h=>h.matches.map(m=>m.mid))).size,cacheHits:s.historyHits,requests:s.historyCalls,requestBudget:64,errors:s.historyErrors,maxPlayers:12,gamesPerPlayer:2}};
 s.result=result;s.phase='done';return '查询完成 · 新读取 '+s.fetched+' 场 / 复用 '+s.reused+' 场';
}
export async function queryStep(s,env,call=upstream){
 const invoke=async(path,params,body)=>{if(s.phase.startsWith('history')){if(s.historyCalls>=64)throw new Fault('近期采样预算已用完',422);s.historyCalls++;}return call(env,path,params,body);};
 if(s.phase==='account'){const a=await invoke('/searchBnetAccount',null,search(env,s.tag));if(!a?.customerToken)throw new Fault('未找到可查询玩家');s.mainToken=a.customerToken;s.phase='list';return '正在读取快速对局列表…';}
 if(s.phase==='list'){
  const games=list(await invoke('/customer/queryMatchList',{token:s.mainToken,gameMode:'leisure',page:s.page,season:''}));for(const m of games)s.listed[m.mid]=m;
  if(Object.keys(s.listed).length<s.limit&&games.length&&s.page<5){s.page++;return '读取第 '+s.page+' 页…';}
  const candidates=new Map((s.prior.matches||[]).filter(m=>usable(m,s.tag)).map(m=>[m.mid,{mid:m.mid,t:m.t,ret:m.ret,mapGuid:m.mapGuid}]));for(const m of Object.values(s.listed))candidates.set(m.mid,m);s.selected=[...candidates.values()].sort((a,b)=>b.t-a.t).slice(0,s.limit);s.phase='details';return '正在合并已有对局…';
 }
 if(s.phase==='details'){
  while(s.index<s.selected.length){const m=s.selected[s.index],old=s.prior.matches.find(p=>p.mid===m.mid);
   if(usable(old,s.tag)&&(!m.mapGuid||m.mapGuid===old.mapGuid)&&(!m.t||m.t===old.t)){s.out.push({...old,ret:m.ret});s.reused++;s.index++;continue;}
   const v=await invoke('/customer/queryMatchInfo',{token:s.mainToken,matchId:m.mid,season:''});s.out.push(detail(v,m,s));s.fetched++;s.index++;return '读取新对局 '+s.index+'/'+s.selected.length+' · 复用 '+s.reused+' 场…';
  }
  s.rankEntries=Object.entries(s.wanted);s.index=0;s.phase='ranks';return '正在补充新增玩家段位…';
 }
 if(s.phase==='ranks'){
  while(s.index<s.rankEntries.length){const [ct,name]=s.rankEntries[s.index];const prior=s.prior.matches.flatMap(m=>m.players).find(p=>p.name===name&&!p.res.error&&Date.now()-Date.parse(p.res.rankQueriedAt)>=0&&Date.now()-Date.parse(p.res.rankQueriedAt)<21600000);
   if(prior){s.ranks[ct]=prior.res;s.rankReused++;s.index++;continue;}
   try{s.ranks[ct]={rows:rows(await invoke('/customer/queryCountInfo',{token:ct,gameMode:'sport',season:''})),rankQueriedAt:s.now};}catch(e){if([429,503,504].includes(e.status))throw e;s.ranks[ct]={rows:[],error:true,rankQueriedAt:s.now};}s.rankFetched++;s.index++;return '补充玩家段位 '+s.index+'/'+s.rankEntries.length+'…';
  }
  for(const m of s.out)for(const p of m.players)if(s.tokens[p.name]&&s.ranks[s.tokens[p.name]])p.res=s.ranks[s.tokens[p.name]];
  beginHistory(s);return '正在补充近期对局参考…';
 }
 try{
  if(s.phase==='history-start'){
   if(s.index>=s.candidates.length)return finish(s);
   const name=s.candidates[s.index],old=(s.prior.recentHistory||[]).find(h=>h.name===name&&!h.matches.some(m=>s.excluded.includes(m.mid))&&Date.now()-Date.parse(h.queriedAt)>=0&&Date.now()-Date.parse(h.queriedAt)<(h.matches.length?21600000:900000));
   if(old){s.histories.push({...old,cached:true});s.historyHits++;s.index++;return '复用近期参考 '+s.index+'/'+s.candidates.length+'…';}
   s.h={name,matches:[],queriedAt:s.now,savedAt:Date.now()/1000,cached:false};s.hToken=s.tokens[name];
   if(!s.hToken){const a=await invoke('/searchBnetAccount',null,search(env,name));if(!a?.customerToken)throw new Fault('近期账号无法查询');s.hToken=a.customerToken;}
   s.phase='history-list';return '补充近期玩家 '+(s.index+1)+'/'+s.candidates.length+'…';
  }
  if(s.phase==='history-list'){s.hList=list(await invoke('/customer/queryMatchList',{token:s.hToken,gameMode:'leisure',page:1,season:''})).sort((a,b)=>b.t-a.t).filter(m=>!s.excluded.includes(m.mid)).slice(0,3);s.hIndex=0;s.phase='history-detail';return '读取近期对局详情…';}
  if(s.phase==='history-detail'){
   if(s.hIndex>=s.hList.length||s.h.matches.length>=2){s.histories.push(s.h);s.index++;s.phase='history-start';return '近期参考已补充 '+s.index+' 位…';}
   const m=s.hList[s.hIndex],v=await invoke('/customer/queryMatchInfo',{token:s.hToken,matchId:m.mid,season:''});s.hGame=detail(v,m,s);s.hRankEntries=[];
   for(const key of ['teammateList','enemyList'])for(const p of v[key]||[])if(p.customerToken&&!s.ranks[p.customerToken]&&s.historyRanks<16){s.historyRanks++;s.hRankEntries.push(p.customerToken);}
   s.hRankIndex=0;s.phase='history-ranks';return '读取近期段位参考…';
  }
  if(s.phase==='history-ranks'){
   if(s.hRankIndex<s.hRankEntries.length){const ct=s.hRankEntries[s.hRankIndex];try{s.ranks[ct]={rows:rows(await invoke('/customer/queryCountInfo',{token:ct,gameMode:'sport',season:''})),rankQueriedAt:s.now};}catch(e){if([429,503,504].includes(e.status))throw e;s.ranks[ct]={rows:[],error:true};}s.hRankIndex++;return '补充近期段位参考…';}
   for(const p of s.hGame.players)p.res=s.ranks[s.tokens[p.name]]||p.res;if(s.hGame.players.some(p=>p.name===s.h.name))s.h.matches.push(s.hGame);s.hIndex++;s.phase='history-detail';return '补充近期战斗数据…';
  }
 }catch(e){if([429,503,504].includes(e.status))throw e;s.historyErrors++;if(s.h)s.histories.push(s.h);s.index++;s.phase='history-start';if(s.historyCalls>=64){for(;s.index<s.candidates.length;s.index++)s.histories.push({name:s.candidates[s.index],matches:[],queriedAt:s.now,cached:false});return finish(s);}return '部分近期参考不可用，继续…';}
 throw new Fault('查询阶段异常',500);
}
