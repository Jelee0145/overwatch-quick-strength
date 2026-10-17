(function(root){
 'use strict';
 const tag=value=>String(value||'').normalize('NFC').trim();
 function merge(previous,envelope,batchId,scope){return root.OWQS_SERVICES.data.mergeArchive(previous,envelope,batchId,scope);}
 function windowRange(total,capacity,start){const size=Math.min(total,Math.max(1,capacity));const first=Math.max(0,Math.min(Math.round(start),total-size));return {start:first,end:first+size};}
 function statisticsRange(total,end,selection){return selection==='all'?{start:0,end:total}:{start:Math.max(0,end-Number(selection)),end};}
 function bufferedRange(total,capacity,offset,padding=3){const size=Math.min(total,capacity),anchor=Math.max(0,Math.min(Math.floor(offset),total-size));return {anchor,start:Math.max(0,anchor-padding),end:Math.min(total,anchor+size+padding),size};}
 function snapDuration(distance,reduced=false){return reduced||Math.abs(distance)<.005?0:Math.round(110+70*Math.min(1,Math.abs(distance)));}
 function snapEase(progress){const t=Math.max(0,Math.min(1,progress));return 1-Math.pow(1-t,3);}
 function axisRange(matches){const values=matches.flatMap(m=>[...(m.scores||[]),...(m.allRoleScores||[]),...(m.estimateRange?[m.estimateRange.min,m.estimateRange.max]:[]),m.mean]).filter(Number.isFinite);const min=values.length?Math.max(500,Math.floor((Math.min(...values)-100)/500)*500):500;let max=values.length?Math.min(5000,Math.ceil((Math.max(...values)+150)/500)*500):3000;if(max<=min)max=Math.min(5000,min+500);return {min,max};}
 root.QS_HISTORY_MODEL={tag,merge,windowRange,statisticsRange,bufferedRange,snapDuration,snapEase,axisRange};
})(typeof window!=='undefined'?window:globalThis);
