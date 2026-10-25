import {Fault} from '../security.mjs';
import {requireMethod,jsonInput} from './context.mjs';
import {readArchive} from '../history/store.mjs';
import {analyzeArchive,analyzeCachedArchive} from '../history/analysis.mjs';
import {webAnalysisView,requireSlimFlag} from '../history/view.mjs';
import {analysisResponseCache,analysisIdentity,analysisKey} from '../history/response.mjs';
import {renderAnalysisChart} from './chart.mjs';

// Windowed reads repeat the same bytes, so validate by archive revision and reuse them.
export {analysisResponseCache};
function catalogRevision(accounts,tag){const found=(accounts||[]).find(account=>String(account.tag||'').normalize('NFC').trim()===tag);return found?found.revision:null;}
function jsonText(body){return new Response(body,{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}

export async function handleHistoryAnalysis({request,env,auth,call,assets,personal}){
 personal(auth);requireMethod(request,'POST');
 const input=await jsonInput(request),options=input.options||{},slim=requireSlimFlag(input);
 if(input.render!==undefined&&input.render!=='svg')throw new Fault('图片格式仅支持 svg');
 const tag=String(input.battletag||input.tag||'').normalize('NFC').trim(),expected=options.revision??input.revision,cacheable=input.render===undefined;
 // The catalog already carries each account's archive revision, so a stable revision can
 // answer a repeated window without touching the signed archive at all.
 const identity=await analysisIdentity(auth.user.id,env);
 let revision=null;
 if(cacheable){
  const catalog=await call('/history',{action:'list'}).catch(()=>null);
  revision=catalogRevision(catalog?.accounts,tag);
  if(revision!==null&&expected!==undefined&&expected!==null&&expected!==revision)throw new Fault('历史已更新，请刷新后重试',409);
  const cached=revision===null?null:analysisResponseCache.get(analysisKey(identity,tag,revision,options,slim));
  if(cached!==null)return jsonText(cached);
 }
 const load=()=>readArchive(call,auth.user.id,env,tag,expected);
 const view=revision===null?await analyzeArchive(await load(),options):await analyzeCachedArchive(load,options,[identity,tag,revision].join('\u0000'),{slim});
 if(input.render==='svg')view.chart=await renderAnalysisChart(view,assets);
 const body=JSON.stringify(slim?webAnalysisView(view):view);
 if(cacheable)analysisResponseCache.set(analysisKey(identity,tag,view.revision,options,slim),body);
 return jsonText(body);
}
