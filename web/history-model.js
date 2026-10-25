(function(root){
 'use strict';
 const tag=value=>String(value||'').normalize('NFC').trim();
 function merge(previous,envelope,batchId,scope){return root.OWQS_SERVICES.data.mergeArchive(previous,envelope,batchId,scope);}
 function mergeMany(previous,batches,scope){return root.OWQS_SERVICES.data.mergeArchiveBatches(previous,batches,scope);}
 const {windowRange,statisticsRange,axisRange}=root.OWQS_SERVICES.historyGeometry;
 function bufferedRange(total,capacity,offset,padding=3){const size=Math.min(total,capacity),anchor=Math.max(0,Math.min(Math.floor(offset),total-size));return {anchor,start:Math.max(0,anchor-padding),end:Math.min(total,anchor+size+padding),size};}
 function snapDuration(distance,reduced=false){return reduced||Math.abs(distance)<.005?0:Math.round(110+70*Math.min(1,Math.abs(distance)));}
 // A window move only needs the server when that window's detail is not here yet, or
 // when statistics end at the window edge and therefore change with it.
 function windowNeedsAnalysis(analysis,tag,statisticsRange,matches,start){
  if(!analysis||analysis.tag!==tag)return true;
  if(String(statisticsRange||'all')!=='all')return true;
  const total=Array.isArray(matches)?matches.length:0;
  if(!total)return true;
  const range=windowRange(total,10,start??0),slice=Array.isArray(matches)?matches.slice(range.start,range.end):[];
  return !slice.length||slice.some(match=>match?.light===true);
 }
 function snapEase(progress){const t=Math.max(0,Math.min(1,progress));return 1-Math.pow(1-t,3);}
 root.QS_HISTORY_MODEL={tag,merge,mergeMany,windowRange,statisticsRange,bufferedRange,snapDuration,snapEase,axisRange,windowNeedsAnalysis};
})(typeof window!=='undefined'?window:globalThis);
