#!/usr/bin/env node
// Upstream rate ladder (Phase 1 of the rate-limit scan).
//
// Holds concurrency at one and steps the launch rate upward, so the ladder measures
// the rate ceiling alone. Concurrency is a separate axis and is only meaningful once
// the rate ceiling is known.
//
// Every request is a real match detail for the probe account itself. The scan sends
// more traffic than phase 0 on purpose: the first 429 ends the ladder immediately.
// Requests go straight to fetch, bypassing server/limiter.mjs pacing.
//
// Never stored or printed: credentials, customer tokens, request URLs.
// Not wired into package.json; run manually.

import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {upstream} from '../backend/src/adapters/dashen.mjs';
import {ServiceError} from '../backend/src/services/errors.mjs';
import {UsageError,loadConfig,maskedTag,describe,requireAbsolute,createProbe,locate} from './upstream-scan-shared.mjs';

export const USAGE=`Usage: node scripts/upstream-scan-rate.mjs --battletag=<名称#编号> [options]

速率阶梯（Phase 1）。并发固定为 1，逐档提高启动速率；首次 429 立即停止。
请求经 src/adapters/dashen.mjs 发出，请求头与线上完全一致。

  --battletag=<名称#编号>  必填。用该账号自己的对局做探针，不访问他人数据。
  --config=<绝对路径>      默认取环境变量 OWQS_CONFIG。
  --rates=<2,4,6,8>        速率档位（req/s），从低到高，最高 20。
  --hold=<秒>              每档持续时间，默认 20。
  --budget=<n>             本次运行的上游请求硬上限，默认 460。
  --output=<绝对路径>      结果写入位置，默认 .private/upstream-rate-scan.json。

并发固定为 1，因此单请求延迟会封顶实测速率（88ms 约 11 req/s）。
更高的目标速率属于 Phase 2 并发轴，不在本脚本范围内。

退出码：0 正常完成（可能已触发 429），2 参数或配置错误，3 未触发 429 即结束。`;

// Most launches falling inside any window of the given length. A paced schedule with
// catch-up can momentarily exceed its own target, and the upstream judges that burst.
export function peakInWindow(times,windowMs){
 let peak=0;
 for(let start=0,end=0;end<times.length;end++){
  while(times[end]-times[start]>=windowMs)start++;
  peak=Math.max(peak,end-start+1);
 }
 return peak;
}

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

 const rates=(value('rates')??'2,4,6,8').split(',').map(Number);
 if(!rates.length||rates.some(r=>!Number.isFinite(r)||r<=0||r>20))throw new UsageError('--rates 必须是 0—20 之间、逗号分隔的正数');
 // Ascending order is what makes "first 429 ends the ladder" a valid stopping rule.
 for(let i=1;i<rates.length;i++)if(rates[i]<=rates[i-1])throw new UsageError('--rates 必须严格递增');

 const hold=Number(value('hold')??20);
 if(!Number.isFinite(hold)||hold<10||hold>120)throw new UsageError('--hold 必须是 10—120 秒');

 const budget=Number(value('budget')??460);
 if(!Number.isInteger(budget)||budget<10)throw new UsageError('--budget 至少 10');

 // A ladder that could outrun its own request ceiling would end mid-ramp and report
 // a ceiling it never reached; require the budget to cover every stage.
 const planned=rates.reduce((sum,rate)=>sum+Math.floor(rate*hold),0)+2;
 if(planned>budget)throw new UsageError(`按当前档位与时长需要约 ${planned} 次请求，超过 --budget=${budget}`);

 const config=value('config')??process.env.OWQS_CONFIG;
 if(!config)throw new UsageError('缺少 --config 或环境变量 OWQS_CONFIG');
 return {tag,rates,hold,budget,config:requireAbsolute(config,'--config'),output:value('output')};
}

/**
 * Run the ladder. Concurrency stays at one: the next launch waits for the previous
 * response, which the observed latency makes affordable well past the target rates.
 * @param {object} options
 * @param {Function} [options.call] Adapter call, for tests.
 * @param {Function} [options.now] Clock, for tests.
 * @param {Function} [options.sleep] Delay, for tests.
 */
export async function ladder({settings,tag,rates,hold,budget,call=upstream,now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const {probe,state}=createProbe({settings,call,budget,now,ServiceError});
 const located=await locate({probe,settings,tag});
 const token=located.token;
 if(!token)throw new UsageError('账号搜索没有返回 customerToken，无法继续');
 // Repeat the account's own matches: probing another account would spend someone
 // else's upstream exposure and buy nothing, since the limit is per credential.
 const pool=located.matchIds;
 if(!pool.length)throw new UsageError('该账号没有可用的对局，无法建立探针池');

 const stages=[];
 let index=0;
 for(const rate of rates){
  if(state.stop)break;
  const gap=1000/rate,stageStart=now(),samples=[],errors=[],launchTimes=[];
  const deadline=stageStart+hold*1000;
  // Launches follow an absolute schedule so sleep overshoot does not compound into
  // a slower rate than the one being measured. Lateness is dropped rather than
  // repaid: catching up by firing the backlog back to back turns a slow response
  // into a burst, and the upstream then judges the burst, not the target rate.
  let nextLaunch=stageStart,limited=false;
  while(now()<deadline){
   if(state.stop)break;
   const wait=nextLaunch-now();
   if(wait>0)await sleep(wait);
   if(now()>=deadline)break;
   nextLaunch=Math.max(nextLaunch+gap,now());
   nextLaunch=Math.max(nextLaunch,now()+1);
   const target=pool[index++%pool.length];
   launchTimes.push(now());
   const result=await probe('/customer/queryMatchInfo',{token,matchId:target,season:''});
   if(result.limited||state.rateLimited){limited=true;break;}
   if(result.error)errors.push(result.error);
   else samples.push(result.elapsed);
  }
  // Derived from the observed launch spacing, not from requests per stage second:
  // counting launches over the stage window reports one request more per window than
  // the schedule allows, which would make an honest 2/s look like 2.1/s.
  const spacing=launchTimes.length>1?(launchTimes.at(-1)-launchTimes[0])/(launchTimes.length-1):0;
  stages.push({
   ratePerSecond:rate,
   completed:!limited,
   limited,
   requests:launchTimes.length,
   // Realized rate is reported alongside the target: timer jitter and request
   // latency both push it down, and only the realized value is comparable.
   realizedPerSecond:limited||!spacing?null:Math.round(1000/spacing*100)/100,
   // The schedule catches up after a slow response by launching immediately, which
   // can put more requests into one second than the target rate allows. Without this
   // number a target rate and the upstream's own window limit cannot be told apart.
   peakPerSecond:peakInWindow(launchTimes,1000),
   errors:errors.length,
   latencyMs:describe(samples),
  });
  if(limited)break;
  // Leave the upstream idle between stages so a sliding window can drain; without
  // this a stage inherits the previous stage's tail and fails earlier than it should.
  await sleep(1000);
 }

 // The last stage that finished cleanly and the first that saw a limit: the safe
 // ceiling sits between them, and the gap is how fast the ladder was stepping.
 const passed=stages.filter(s=>s.completed&&!s.limited);
 return {
  scannedAt:new Date().toISOString(),
  phase:1,
  host:os.hostname(),
  account:maskedTag(tag),
  concurrency:1,
  holdSeconds:hold,
  requests:state.requests,
  budget,
  rateLimited:state.rateLimited,
  retryAfterHeader:state.retryAfter,
  safeRatePerSecond:passed.length?passed.at(-1).ratePerSecond:null,
  limitedRatePerSecond:stages.find(s=>s.limited)?.ratePerSecond??null,
  stages,
 };
}

async function main(){
 const argv=process.argv.slice(2);
 if(argv.includes('--help')||argv.includes('-h')){console.log(USAGE);return 0;}
 let options;
 try{options=parseArgs(argv);}catch(error){console.error(error.message+'\n\n'+USAGE);return 2;}
 let settings;
 try{settings=await loadConfig(path.resolve(options.config));}catch(error){console.error(error.message);return 2;}

 const outputPath=path.resolve(options.output??path.join(path.resolve(import.meta.dirname,'..'),'.private','upstream-rate-scan.json'));
 console.log(`速率阶梯 ${options.rates.join(' → ')} req/s，每档 ${options.hold} 秒，并发 1（账号 ${maskedTag(options.tag)}）…`);

 let report;
 try{
  report=await ladder({settings,tag:options.tag,rates:options.rates,hold:options.hold,budget:options.budget});
 }catch(error){
  console.error(error.message);
  return 2;
 }

 await mkdir(path.dirname(outputPath),{recursive:true});
 await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');

 console.log('');
 for(const stage of report.stages){
  const latency=stage.latencyMs;
  const outcome=stage.limited?'限流':stage.completed?'通过':'中断';
  console.log(`  ${String(stage.ratePerSecond).padStart(2)} req/s · 实测 ${String(stage.realizedPerSecond||'-').padStart(4)}/s · ${String(stage.requests).padStart(3)} 次 · ${outcome}${latency?` · p50 ${latency.p50}ms p95 ${latency.p95}ms`:''}${stage.errors?` · 错误 ${stage.errors}`:''}`);
 }
 console.log('');
 console.log(`上游请求 ${report.requests} 次 · 429 ${report.rateLimited?'是':'否'}${report.retryAfterHeader?` · Retry-After: ${report.retryAfterHeader}`:' · 无 Retry-After'}`);
 if(report.safeRatePerSecond)console.log(`未触发限流的最高档：${report.safeRatePerSecond} req/s`);
 if(report.limitedRatePerSecond)console.log(`首次触发限流的档位：${report.limitedRatePerSecond} req/s`);
 console.log(`结果：${outputPath}`);
 return report.rateLimited?0:3;
}

if(import.meta.main)process.exit(await main());
