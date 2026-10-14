(function(root){
 'use strict';
 const tag=value=>String(value||'').normalize('NFC').trim();
 function merge(previous,envelope,batchId,scope){
  const data=envelope?.content?.data;
  if(!data||!Array.isArray(data.matches)||data.matches.length>50)throw Error('历史归档缺少有效查询结果');
  const account=tag(data.battletag);
  if(!account||previous&&(previous.scope!==scope||previous.tag!==account))throw Error('历史归档账号或范围不一致');
  const batches={...(previous?.batches||{}),[batchId]:envelope},index=new Map((previous?.matches||[]).map(m=>[m.mid,m]));
  for(const m of data.matches){const mid=String(m.mid);if(!mid||!Array.isArray(m.players))throw Error('历史对局数据不完整');const old=index.get(mid),queriedAt=data.queriedAt;
   if(old&&Date.parse(old.queriedAt)>Date.parse(queriedAt))continue;
   index.set(mid,{mid,t:Number(m.t)||0,mapGuid:m.mapGuid,mapName:m.mapName,ret:m.ret,batchId,queriedAt});
  }
  const matches=[...index.values()].sort((a,b)=>a.t-b.t||a.mid.localeCompare(b.mid)).slice(-500),used=new Set(matches.map(m=>m.batchId));
  for(const key of Object.keys(batches))if(!used.has(key))delete batches[key];
  return {version:1,scope,tag:account,updatedAt:Date.parse(previous?.updatedAt)>Date.parse(data.queriedAt)?previous.updatedAt:data.queriedAt,matches,batches};
 }
 function windowRange(total,capacity,start){const size=Math.min(total,Math.max(1,capacity));const first=Math.max(0,Math.min(Math.round(start),total-size));return {start:first,end:first+size};}
 function statisticsRange(total,end,selection){return selection==='all'?{start:0,end:total}:{start:Math.max(0,end-Number(selection)),end};}
 function bufferedRange(total,capacity,offset,padding=3){const size=Math.min(total,capacity),anchor=Math.max(0,Math.min(Math.floor(offset),total-size));return {anchor,start:Math.max(0,anchor-padding),end:Math.min(total,anchor+size+padding),size};}
 function snapDuration(distance,reduced=false){return reduced||Math.abs(distance)<.005?0:Math.round(110+70*Math.min(1,Math.abs(distance)));}
 function snapEase(progress){const t=Math.max(0,Math.min(1,progress));return 1-Math.pow(1-t,3);}
 function axisRange(matches){const values=matches.flatMap(m=>[...(m.scores||[]),...(m.allRoleScores||[]),...(m.estimateRange?[m.estimateRange.min,m.estimateRange.max]:[]),m.mean]).filter(Number.isFinite);const min=values.length?Math.max(500,Math.floor((Math.min(...values)-100)/500)*500):500;let max=values.length?Math.min(5000,Math.ceil((Math.max(...values)+150)/500)*500):3000;if(max<=min)max=Math.min(5000,min+500);return {min,max};}
 root.QS_HISTORY_MODEL={tag,merge,windowRange,statisticsRange,bufferedRange,snapDuration,snapEase,axisRange};
})(typeof window!=='undefined'?window:globalThis);
