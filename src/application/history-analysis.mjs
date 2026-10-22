import {analysisService,dataService} from '../services/runtime.mjs';
import {Fault,canonical,digest} from '../security.mjs';
import {projectApiMatch} from '../api-match.mjs';

import * as historyModel from '../services/history-geometry.mjs';
import {normalizeAnalysisOptions} from './analysis-options.mjs';

const MAX_MATCHES=500,WINDOW=10;
const name=value=>typeof value==='string'?value.normalize('NFC').trim():'';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const revisionPattern=/^[a-f0-9]{64}$/;

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
 const prepared=await prepareArchive(input,options),{archive,revision}=prepared,normalized=prepared.options;
 const history=analysisService.analyzeHistory(archive,normalized),total=history.matches.length;
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

export async function selectArchiveMatch(input,target,options={}){
 const {archive,revision,options:normalized}=await prepareArchive(input,options),mid=validateReference(target,archive,revision);
 const history=analysisService.analyzeHistory(archive,normalized),index=history.matches.findIndex(match=>match.mid===mid);
 if(index<0)throw new Fault('历史对局不存在或不属于当前模式',404);
 const match=history.matches[index],ref=reference(archive,revision,mid),detail=projectApiMatch(history.raw,match,normalized,{index:index+1,count:history.matches.length});
 return {raw:history.raw,match,ref,detail:{...detail,ref}};
}
export function createHistoryAnalysisService(){return Object.freeze({analyzeArchive,selectArchiveMatch,selectArchiveEnvelope});}
