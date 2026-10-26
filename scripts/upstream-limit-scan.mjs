#!/usr/bin/env node
// Read-only upstream latency baseline (Phase 0 of the rate-limit scan).
//
// Measures the real round-trip distribution of the matches API through the same
// adapter, headers and error mapping the query engine uses, so the later rate and
// concurrency phases can be sized from data instead of guesses.
//
// Deliberately serial with a fixed gap: phase 0 must not itself discover a 429.
// The gap does not distort per-request latency because requests never overlap.
// Requests go straight to fetch, bypassing server/limiter.mjs pacing.
//
// Never stored or printed: credentials, customer tokens, request URLs.
// Not wired into package.json; run manually.

import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {upstream} from '../src/adapters/dashen.mjs';
import {ServiceError} from '../src/services/errors.mjs';
import {UsageError,loadConfig,maskedTag,describe,inFlightTable,createProbe} from './upstream-scan-shared.mjs';

// Re-exported so existing imports and tests keep one entry point per phase.
export {UsageError,loadConfig,maskedTag,describe,inFlightTable};

export const USAGE=`Usage: node scripts/upstream-limit-scan.mjs --battletag=<名称#编号> [options]

只读延迟基线（Phase 0）。串行、固定间隔，不使用并发，不试探限流阈值。
请求经 src/adapters/dashen.mjs 发出，请求头与线上完全一致。

  --battletag=<名称#编号>  必填。用该账号自己的对局做探针，不访问他人数据。
  --config=<绝对路径>      默认取环境变量 OWQS_CONFIG。
  --probes=<n>             对局详情探针数，默认 10，上限 30。
  --gap=<毫秒>             相邻探针间隔，默认 600（约 1.67/s，低于已知安全的 2/s）。
  --budget=<n>             本次运行的上游请求硬上限，默认 16。
  --output=<绝对路径>      结果写入位置，默认 .private/upstream-limit-scan.json。

退出码：0 正常，2 参数或配置错误，3 触发 429（已按要求立即停止）。`;

export function parseArgs(argv){
 const value=name=>{
  const found=argv.find(a=>a===`--${name}`||a.startsWith(`--${name}=`));
  if(found===undefined)return undefined;
  if(!found.includes('='))throw new UsageError(`--${name} 需要取值`);
  return found.slice(found.indexOf('=')+1);
 };
 const tag=value('battletag');
 if(!tag)throw new UsageError('缺少 --battletag');
 if(!/^.+#\d+$/.test(tag))throw new UsageError('--battletag 必须是完整昵称，例如 Name#1234');
 const probes=Number(value('probes')??10),gap=Number(value('gap')??600),budget=Number(value('budget')??16);
 if(!Number.isInteger(probes)||probes<1||probes>30)throw new UsageError('--probes 必须是 1—30 的整数');
 if(!Number.isFinite(gap)||gap<200)throw new UsageError('--gap 至少 200 毫秒');
 if(!Number.isInteger(budget)||budget<3)throw new UsageError('--budget 至少 3');
 const config=value('config')??process.env.OWQS_CONFIG;
 if(!config)throw new UsageError('缺少 --config 或环境变量 OWQS_CONFIG');
 if(!path.isAbsolute(config))throw new UsageError('--config 必须是绝对路径');
 return {tag,probes,gap,budget,config,output:value('output')};
}

/**
 * Serial probe run. Returns the report object; never prints or persists secrets.
 * @param {object} options
 * @param {object} options.settings Adapter credential fields.
 * @param {string} options.tag In-game tag; only its own matches are read.
 * @param {number} options.probes Detail probe count.
 * @param {number} options.gap Milliseconds between launches.
 * @param {number} options.budget Hard upstream request ceiling.
 * @param {Function} [options.now] Clock, for tests.
 * @param {Function} [options.sleep] Delay, for tests.
 */
export async function scan({settings,tag,probes,gap,budget,now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),call=upstream}){
 const {probe,state}=createProbe({settings,call,budget,now,ServiceError});
 const detailSamples=[];
 const stop=()=>state.stop;

 const account=await probe('/searchBnetAccount',null,{name:tag,token:settings.DASHEN_TOKEN,roleId:settings.DASHEN_ROLE_ID,dts:settings.DASHEN_DTS,server:settings.DASHEN_SERVER});
 const token=account.value?.customerToken;
 if(!stop()&&!token)throw new UsageError('账号搜索没有返回 customerToken，无法继续');

 let matchIds=[];
 if(!stop()){
  await sleep(gap);
  const list=await probe('/customer/queryMatchList',{token,gameMode:'leisure',page:1,season:''});
  const rows=Array.isArray(list.value)?list.value:list.value?.matchList||list.value?.recentMatchList||[];
  matchIds=rows.map(m=>String(m?.matchId||'')).filter(Boolean).slice(0,probes);
 }

 for(const [index,mid] of matchIds.entries()){
  if(stop())break;
  if(index)await sleep(gap);
  const result=await probe('/customer/queryMatchInfo',{token,matchId:mid,season:''});
  if(!result.error&&!result.limited)detailSamples.push(result.elapsed);
 }
 const requests=state.requests,rateLimited=state.rateLimited,byPath=state.byPath,capture={retryAfter:state.retryAfter};

 const latencyMs=describe(detailSamples);
 return {
  scannedAt:new Date().toISOString(),
  phase:0,
  // Rate limits may be keyed on egress IP, so a result is only valid for the host
  // that produced it. Record the hostname to keep local runs from being mistaken
  // for production numbers.
  host:os.hostname(),
  account:maskedTag(tag),
  probes:{requested:probes,completed:detailSamples.length},
  requests,
  rateLimited,
  retryAfterHeader:capture.retryAfter,
  latencyMs,
  pacing:{gapMs:gap,serial:true},
  // Ordered detail round trips. A rising sequence points at per-token warmup, while
  // a flat one points at hop latency; the summary alone cannot tell those apart.
  // Each launch is separated by gap, so index * gap approximates elapsed time.
  detailSamples:detailSamples.map(Math.round),
  // Every endpoint, not only details: account search and lists may be served from a
  // different backend tier, and mixing them would hide that.
  latencyByPath:Object.fromEntries(Object.entries(byPath).map(([name,values])=>[name,describe(values)])),
  budget,
  implied:latencyMs?inFlightTable(latencyMs.p95):[],
 };
}

async function main(){
 const argv=process.argv.slice(2);
 if(argv.includes('--help')||argv.includes('-h')){console.log(USAGE);return 0;}
 let options;
 try{options=parseArgs(argv);}catch(error){console.error(error.message+'\n\n'+USAGE);return 2;}

 let settings;
 try{settings=await loadConfig(path.resolve(options.config));}catch(error){console.error(error.message);return 2;}

 const outputPath=path.resolve(options.output??path.join(path.resolve(import.meta.dirname,'..'),'.private','upstream-limit-scan.json'));
 console.log(`读取对局列表以确定探针（账号 ${maskedTag(options.tag)}）…`);

 let report;
 try{
  report=await scan({settings,tag:options.tag,probes:options.probes,gap:options.gap,budget:options.budget});
 }catch(error){
  console.error(error.message);
  return 2;
 }

 await mkdir(path.dirname(outputPath),{recursive:true});
 await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');

 console.log('');
 if(report.latencyMs){
  console.log('各接口延迟');
  for(const [name,value] of Object.entries(report.latencyByPath))
   console.log(`  ${name} (n=${value.n}) min ${value.min} · p50 ${value.p50} · p95 ${value.p95} · max ${value.max}ms`);
  console.log('');
  console.log('要达到目标速率需要的在途请求数（按详情 p95）');
  for(const row of report.implied)console.log(`  ${String(row.ratePerSecond).padStart(2)} req/s → ${row.inFlightNeeded} · ${row.note}`);
 }else{
  console.log('没有取得有效的详情延迟样本。');
 }
 console.log('');
 console.log(`上游请求 ${report.requests} 次 · 429 ${report.rateLimited?'是':'否'}${report.retryAfterHeader?` · Retry-After: ${report.retryAfterHeader}`:' · 无 Retry-After'}`);
 console.log(`结果：${outputPath}`);
 if(report.rateLimited){console.log('已按要求立即停止。');return 3;}
 return report.latencyMs?0:2;
}

if(import.meta.main)process.exit(await main());
