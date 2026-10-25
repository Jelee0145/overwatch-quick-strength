import {analysisService,dataService} from '../services/runtime.mjs';
import {Fault,canonical,digest} from '../security.mjs';
import {projectApiMatch} from '../api/match.mjs';
import {compactWebMatch} from './view.mjs';

import * as historyModel from '../services/history-geometry.mjs';
import {normalizeAnalysisOptions} from '../query/analysis-options.mjs';

const MAX_MATCHES=500,WINDOW=10;
const name=value=>typeof value==='string'?value.normalize('NFC').trim():'';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const revisionPattern=/^[a-f0-9]{64}$/;
const contexts=new Map(),computations=new Map();let contextBytes=0;
export const historyComputationCache={clear(){contexts.clear();contextBytes=0;},stats(){return {entries:contexts.size,bytes:contextBytes};}};
// Only authenticated loaders may opt into this process-local cache. The caller binds
// identity, signing-key generation, scope and archive revision in `key`.
export async function analyzeCachedArchive(load,options,key,{slim=false}={}){
 const normalized=normalizeHistoryAnalysisOptions(options),computeKey=key+'\u0000'+(slim?'slim':'full')+'\u0000'+canonical({...normalized,start:undefined,statisticsRange:undefined});
 let hit=contexts.get(computeKey);
 if(hit){contexts.delete(computeKey);contexts.set(computeKey,hit);}
 else{
  let work=computations.get(computeKey);
  if(!work){work=(async()=>{
  let prepared=await prepareArchive(await load(),options),history=analysisService.analyzeHistory(prepared.archive,prepared.options);
  if(slim)history={...history,matches:history.matches.map(match=>{
   const compact=compactWebMatch(match);compact.players=compact.playerIndices.map(i=>compact.combatPlayers[i]);return compact;
  })};
  // Source envelopes are no longer needed after verification and evaluation. Keep
  // normalized raw rows for actual-rank summaries; detail requests load their own source.
  prepared={...prepared,archive:{tag:prepared.archive.tag,scope:prepared.archive.scope}};
  const size=new TextEncoder().encode(JSON.stringify({prepared,history})).length*2;
  const entry={prepared,history,size};
  // Conservative UTF-8 x2 accounting covers object overhead; large accounts are admitted
  // only when they fit, and can never displace more than the fixed 32 MiB budget.
  if(size<=32*1024*1024){
   contexts.set(computeKey,entry);contextBytes+=size;
   for(const [id,value] of contexts){if(contextBytes<=32*1024*1024&&contexts.size<=4)break;contexts.delete(id);contextBytes-=value.size;}
  }
  return entry;
  })().finally(()=>computations.delete(computeKey));computations.set(computeKey,work);}
  hit=await work;
 }
 if(options.revision!==undefined&&options.revision!==hit.prepared.revision)throw new Fault('历史记录已更新，请刷新后重试',409);
 return summarizeArchive({...hit.prepared,options:normalized},hit.history);
}

/** Auth/signature verification belongs to the archive loader. This module never trusts its match index. */
export function normalizeHistoryAnalysisOptions(options={}){
 if(!object(options))throw new Fault('历史分析参数无效');
 const analysis=normalizeAnalysisOptions(options);
 if(options.start!==undefined&&!Number.isSafeInteger(options.start))throw new Fault('历史窗口位置必须为整数');
 if(options.revision!==undefined&&(typeof options.revision!=='string'||!revisionPattern.test(options.revision)))throw new Fault('历史版本格式无效');
 return {start:options.start,...analysis};
}

async function prepareArchive(input,options={}){
 if(!object(input)||!object(input.batches)||!name(input.tag)||input.tag.length>150)throw new Fault('历史归档格式无效');
 const normalized=normalizeHistoryAnalysisOptions(options),ids=Object.keys(input.batches).sort();
 if(ids.length>500)throw new Fault('历史签名包数量超出上限');
 const tag=name(input.tag);let scope=input.scope??null,signedScope=null;
 for(const id of ids){
  const envelope=input.batches[id],data=envelope?.content?.data;
  if(!id||id.length>150||!object(data)||name(data.battletag)!==tag||!Array.isArray(data.matches)||data.matches.length>50||!Number.isFinite(Date.parse(data.queriedAt)))throw new Fault('历史签名包内容无效');
  const envelopeScope=envelope.content.scope;
  if(envelopeScope){
   const current={server:envelopeScope.server,dts:envelopeScope.dts};
   if(envelopeScope.battletag!==undefined&&name(envelopeScope.battletag)!==tag)throw new Fault('历史签名包账号不匹配');
   if(signedScope!==null&&canonical(signedScope)!==canonical(current))throw new Fault('历史签名包范围不匹配');
   signedScope=current;
   if(scope===null)scope=current;
   // String scopes are archive partition digests; the authenticated loader verifies them.
   if(object(scope)&&canonical(scope)!==canonical(current))throw new Fault('历史签名包范围不匹配');
  }
  for(const match of data.matches)if(!object(match)||typeof match.mid!=='string'||!match.mid||match.mid.length>150||!Number.isFinite(Number(match.t))||!Array.isArray(match.players)||match.players.length>30)throw new Fault('历史对局内容无效');
 }
 if(scope!==null&&typeof scope!=='string'&&!object(scope)||typeof scope==='string'&&scope.length>300)throw new Fault('历史归档范围无效');
 const revision=await digest(ids.join(','));
 for(const expected of [input.revision,options.revision])if(expected!==undefined){
  if(typeof expected!=='string'||!revisionPattern.test(expected))throw new Fault('历史版本格式无效');
  if(expected!==revision)throw new Fault('历史记录已更新，请刷新后重试',409);
 }
 return {archive:{...input,tag,scope,batches:input.batches,matches:dataService.indexHistory(input.batches,{limit:MAX_MATCHES})},revision,options:normalized};
}
const reference=(archive,revision,mid)=>({scope:archive.scope,tag:archive.tag,mid,revision});
function validateReference(target,archive,revision){
 const mid=typeof target==='string'?target:target?.mid;
 if(typeof mid!=='string'||!mid||mid.length>150)throw new Fault('历史对局标识无效');
 if(typeof target!=='string'){
  if(!object(target)||target.tag!==archive.tag||canonical(target.scope)!==canonical(archive.scope))throw new Fault('历史对局账号或范围不匹配');
  if(typeof target.revision!=='string'||!revisionPattern.test(target.revision))throw new Fault('历史版本格式无效');
  if(target.revision!==revision)throw new Fault('历史记录已更新，请刷新后重试',409);
 }
 return mid;
}

export async function analyzeArchive(input,options={}){
 const prepared=await prepareArchive(input,options);
 return summarizeArchive(prepared,analysisService.analyzeHistory(prepared.archive,prepared.options));
}
function summarizeArchive(prepared,history){
 const {archive,revision}=prepared,normalized={...prepared.options},total=history.matches.length;
 const window=historyModel.windowRange(total,WINDOW,normalized.start??Math.max(0,total-WINDOW));
 normalized.start=window.start;
 const statistics=historyModel.statisticsRange(total,window.end,normalized.statisticsRange),statsMatches=history.matches.slice(statistics.start,statistics.end);
 const model=analysisService.summarize(history.raw,statsMatches,normalized,{records:history.personalRecords,excluded:history.personalExcluded});
 const axis=historyModel.axisRange(history.matches),statisticsLabel=(normalized.statisticsRange==='all'?'全部历史':'窗口末尾向前')+' · '+statsMatches.length+' 场';
 const chartView={...model,matches:history.matches.slice(window.start,window.end),statsMatches:model.matches,windowOffset:window.start,displayLimit:WINDOW,plotScale:axis,axis,statisticsRange:normalized.statisticsRange,statisticsLabel};
 return {version:1,revision,scope:archive.scope,tag:archive.tag,options:normalized,total,window,statistics,axis,...history,model,chartView,statisticsRange:normalized.statisticsRange,statisticsLabel,matchRefs:history.matches.map(match=>reference(archive,revision,match.mid))};
}

/** Return the original winning signed envelope for review, never a newly flattened/re-signed snapshot. */
export async function selectArchiveEnvelope(input,target,options={}){
 const {archive,revision}=await prepareArchive(input,options),mid=validateReference(target,archive,revision),entry=archive.matches.find(match=>match.mid===mid);
 if(!entry)throw new Fault('历史对局不存在',404);
 return {envelope:archive.batches[entry.batchId],batchId:entry.batchId,ref:reference(archive,revision,mid)};
}

export async function selectArchiveMatch(input,target,options={},{slim=false}={}){
 const {archive,revision,options:normalized}=await prepareArchive(input,options),mid=validateReference(target,archive,revision);
 if(slim){
  const entry=archive.matches.find(match=>match.mid===mid),envelope=entry&&archive.batches[entry.batchId];
  const match=envelope&&analysisService.analyzeBatch(envelope.content.data,normalized).matches.find(match=>match.mid===mid);
  if(!match)throw new Fault('历史对局不存在或不属于当前模式',404);
  return {match,ref:reference(archive,revision,mid)};
 }
 const history=analysisService.analyzeHistory(archive,normalized),index=history.matches.findIndex(match=>match.mid===mid);
 if(index<0)throw new Fault('历史对局不存在或不属于当前模式',404);
 const match=history.matches[index],ref=reference(archive,revision,mid),detail=projectApiMatch(history.raw,match,normalized,{index:index+1,count:history.matches.length});
 return {raw:history.raw,match,ref,detail:{...detail,ref}};
}
export function createHistoryAnalysisService(){return Object.freeze({analyzeArchive,selectArchiveMatch,selectArchiveEnvelope});}
