const hero='207165582859042818',now=()=>new Date().toISOString();
export const roster=(side)=>Array.from({length:5},(_,i)=>({name:side==='T'&&i===0?'Main#100':side+i+'#100',heroGuid:hero,customerToken:side+i+'-private',kill:20,assist:8,death:4,heroDamage:10000,cure:0,resistDamage:0,finalHit:10,soloKill:2,targetCompetingTime:20,healingTaken:3000,damageTaken:8000}));
export const names=[...roster('T'),...roster('E')].map(p=>p.name);
export function service({dense=true,delay=0,newGames=10,historyEmpty=false,added=0}={}){
 const counts={},details=[],began=[],active={value:0,max:0};
 const call=async(env,path,p,b)=>{counts[path]=(counts[path]||0)+1;began.push({path,name:b?.name,mid:p?.matchId});active.max=Math.max(active.max,++active.value);try{if(delay)await new Promise(r=>setTimeout(r,delay));
  if(path==='/searchBnetAccount')return {customerToken:names.includes(b.name)?[...roster('T'),...roster('E')].find(p=>p.name===b.name).customerToken:'main-private'};
  if(path==='/customer/queryMatchList'){
   if(p.token==='main-private'||p.token==='T0-private')return {matchList:[...Array.from({length:added},(_,i)=>({matchId:'added'+i,beginTs:300-i,matchRet:1,mapGuid:'map'})),...Array.from({length:newGames},(_,i)=>({matchId:'m'+i,beginTs:200-i,matchRet:1,mapGuid:'map'}))]};
   return {matchList:historyEmpty?[]:[{matchId:'shared-history',beginTs:100,matchRet:p.token.startsWith('E')?-1:1,mapGuid:'map'}]};
  }
  if(path==='/customer/queryMatchInfo'){details.push(p.matchId);const flip=p.token?.startsWith('E');return {gameTimeSec:600,teamScore:flip?0:3,opponentScore:flip?3:0,teammateList:roster(flip?'E':'T'),enemyList:roster(flip?'T':'E')};}
  if(path==='/customer/queryCountInfo')return {guideCountData:dense?[{roleType:'dps',lastRankInfo:{rankScore:300,rankName:'白金',rankSubTier:3}}]:[]};throw Error('Unexpected '+path);
 }finally{active.value--;}};
 return {call,counts,details,began,active};
}
