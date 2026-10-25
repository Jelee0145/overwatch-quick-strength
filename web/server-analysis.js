(function(root){
 'use strict';
 const pending=new Map(),memory=new Map(),generations=new Map();
 function remember(id,value){memory.delete(id);memory.set(id,value);while(memory.size>3)memory.delete(memory.keys().next().value);return value;}
 const normalize=value=>({start:Number.isFinite(value.start)?Math.max(0,Math.round(value.start)):null,statisticsRange:String(value.statisticsRange||'all'),pool:value.pool||'',side:value.side||'all',strategy:value.strategy||'role',estimate:value.estimate!==false,sourceJob:value.sourceJob||null});
 const storageKey=(scope,tag)=>'server-analysis|'+scope+'|'+tag;
 async function load(tag,options={}){
  const session=await Cloud.boot(),scope=session.user.id+'|'+session.scope.server+'|'+session.scope.dts,selection=normalize(options),key=JSON.stringify(selection),id=scope+'|'+tag+'|'+key+'|'+(generations.get(tag)||0);
  if(memory.has(id))return remember(id,memory.get(id));
  if(pending.has(id))return pending.get(id);
  const work=(async()=>{
   let cached;try{cached=await Cloud.storage(storageKey(scope,tag));}catch{}
   try{
    const {sourceJob,...analysisOptions}=options;
    const value=await Cloud.api(sourceJob?'/api/v1/jobs/'+encodeURIComponent(sourceJob)+'/analysis':'/api/v1/history/analysis',{battletag:tag,slim:true,options:{...analysisOptions,start:selection.start??undefined,statisticsRange:selection.statisticsRange}});
    if(value.version!==1||!Array.isArray(value.matches)||!value.model||!value.raw||!value.window)throw Error('历史分析返回格式异常');
    const result={...value,offline:false};remember(id,result);
    // A bounded set of exact server summaries can be reused offline without running scoring code.
    const entries=cached?.version===1&&cached.revision===value.revision?cached.entries||{}:{};
    delete entries[key];entries[key]=value;for(const old of Object.keys(entries).slice(0,-3))delete entries[old];
    try{await Cloud.storage(storageKey(scope,tag),{version:1,revision:value.revision,entries});}catch{}
    return result;
   }catch(error){
    if(error.status&&error.status<500)throw error;
    const value=cached?.version===1&&cached.entries?.[key];if(value){const result={...value,offline:true};remember(id,result);return result;}
    throw error;
   }
  })().finally(()=>pending.delete(id));pending.set(id,work);return work;
 }
 function invalidate(tag){generations.set(tag,(generations.get(tag)||0)+1);for(const key of memory.keys())if(key.includes('|'+tag+'|'))memory.delete(key);}
 root.addEventListener?.('online',()=>memory.clear());
 root.OWQS_SERVER_ANALYSIS=Object.freeze({load,invalidate});
})(window);
