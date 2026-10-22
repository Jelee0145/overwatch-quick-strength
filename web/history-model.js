(function(root){
 'use strict';
 const tag=value=>String(value||'').normalize('NFC').trim();
 function merge(previous,envelope,batchId,scope){return root.OWQS_SERVICES.data.mergeArchive(previous,envelope,batchId,scope);}
 const {windowRange,statisticsRange,axisRange}=root.OWQS_SERVICES.historyGeometry;
 function bufferedRange(total,capacity,offset,padding=3){const size=Math.min(total,capacity),anchor=Math.max(0,Math.min(Math.floor(offset),total-size));return {anchor,start:Math.max(0,anchor-padding),end:Math.min(total,anchor+size+padding),size};}
 function snapDuration(distance,reduced=false){return reduced||Math.abs(distance)<.005?0:Math.round(110+70*Math.min(1,Math.abs(distance)));}
 function snapEase(progress){const t=Math.max(0,Math.min(1,progress));return 1-Math.pow(1-t,3);}
 root.QS_HISTORY_MODEL={tag,merge,windowRange,statisticsRange,bufferedRange,snapDuration,snapEase,axisRange};
})(typeof window!=='undefined'?window:globalThis);
