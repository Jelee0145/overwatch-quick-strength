import {canonical,digest} from '../security.mjs';
import {createResponseCache} from './cache.mjs';
import {analyzeCachedArchive,normalizeHistoryAnalysisOptions} from './analysis.mjs';
import {webAnalysisView} from './view.mjs';
import {readArchive} from './store.mjs';

export const analysisResponseCache=createResponseCache();
export const analysisIdentity=(user,env)=>digest(canonical({user,server:env.DASHEN_SERVER,dts:env.DASHEN_DTS,signingKey:env.CACHE_SIGNING_KEY}));
export function analysisKey(identity,tag,revision,options,slim){return [identity,tag,revision,slim?1:0,canonical(normalizeHistoryAnalysisOptions(options))].join('\u0000');}

// Called only after a successful personal archive. Warming is best effort and uses
// the exact same authenticated loader, scope and cache keys as the public read.
export async function warmHistoryAnalysis(user,env,history,tag,options={}){
 const call=(_path,body)=>history.handle(user,body),catalog=await call('/history',{action:'list'}),account=catalog.accounts.find(a=>a.tag===tag);
 if(!account||account.count>200)return;
 const selection={side:options.side||'all',strategy:options.strategy||'role',estimate:options.estimate!==false,pool:options.pool||'',statisticsRange:String(options.statisticsRange||'all')};
 const identity=await analysisIdentity(user,env),view=await analyzeCachedArchive(()=>readArchive(call,user,env,tag,account.revision),selection,[identity,tag,account.revision].join('\u0000'),{slim:true});
 analysisResponseCache.set(analysisKey(identity,tag,view.revision,selection,true),JSON.stringify(webAnalysisView(view)));
}
