// Shared pieces of the upstream scan scripts. Not a runtime module: these are
// operator tools, and nothing here may be imported by the server or the worker.

import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';

export class UsageError extends Error{}

// A directory, symlink or device here would let an operator probe the wrong file.
export async function loadConfig(configPath){
 const stats=await lstat(configPath).catch(()=>null);
 if(!stats||!stats.isFile())throw new UsageError('--config 必须指向已存在的普通文件（不能是目录或符号链接）');
 let settings;
 try{settings=JSON.parse(await readFile(configPath,'utf8'));}catch{throw new UsageError('配置文件不是有效 JSON');}
 for(const key of ['DASHEN_TOKEN','DASHEN_ROLE_ID','DASHEN_DTS','DASHEN_SERVER'])if(!settings[key])throw new UsageError(`配置缺少 ${key}`);
 // Only adapter fields are forwarded; unrelated secrets in the file stay there.
 return {DASHEN_TOKEN:settings.DASHEN_TOKEN,DASHEN_ROLE_ID:settings.DASHEN_ROLE_ID,DASHEN_DTS:settings.DASHEN_DTS,DASHEN_SERVER:settings.DASHEN_SERVER};
}

export const maskedTag=tag=>tag.replace(/^(.).*?(#\d+)$/,(_,first,suffix)=>first+'***'+suffix);

export function describe(values){
 if(!values.length)return null;
 const quantile=(sorted,p)=>sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)];
 const sorted=[...values].sort((a,b)=>a-b),sum=sorted.reduce((a,b)=>a+b,0);
 return {n:sorted.length,min:Math.round(sorted[0]),p50:Math.round(quantile(sorted,.5)),p90:Math.round(quantile(sorted,.9)),p95:Math.round(quantile(sorted,.95)),max:Math.round(sorted.at(-1)),mean:Math.round(sum/sorted.length)};
}

// In-flight requests needed to sustain a rate given an observed round trip.
// This is the number that decides whether rate or concurrency limits the engine.
export function inFlightTable(latencyMs,rates=[2,3,4,6,8,10]){
 return rates.map(rate=>{const needed=Math.ceil(rate*latencyMs/1000);return {ratePerSecond:rate,inFlightNeeded:needed,note:needed<=3?'速率是约束':'并发是约束'};});
}

export function requireAbsolute(value,flag){
 if(!path.isAbsolute(value))throw new UsageError(`${flag} 必须是绝对路径`);
 return value;
}

/**
 * Probe harness shared by the scan phases.
 *
 * Wraps the fetcher because the adapter maps 429 to a Fault and drops the response
 * headers, so Retry-After is only observable here. The budget is enforced per probe
 * rather than in the fetcher, so it also holds when a test supplies its own upstream.
 * init is passed through untouched: redirect handling and timeouts stay identical to
 * production, which is the whole point of measuring through the real adapter.
 * @returns {{probe:Function,state:object,env:object}}
 */
export function createProbe({settings,call,budget,now=()=>performance.now(),ServiceError}){
 const env={...settings};
 // byPath keeps per-endpoint round trips: account search, lists and details may be
 // served from different backend tiers, and a merged summary would hide that.
 const state={requests:0,rateLimited:false,retryAfter:null,lastStatus:null,stop:false,byPath:{}};

 env.UPSTREAM_FETCH=async (url,init)=>{
  const response=await fetch(url,init);
  state.lastStatus=response.status;
  state.retryAfter=response.headers.get('Retry-After');
  if(response.status===429)state.rateLimited=true;
  return response;
 };

 async function probe(pathname,params,body){
  // A ceiling rather than a suggestion: a scan must never exceed a known request count.
  if(++state.requests>budget){state.stop=true;throw new UsageError('已用尽本次请求预算');}
  const started=now();
  try{
   const value=await call(env,pathname,params,body);
   const elapsed=now()-started;
   if(state.lastStatus===429){state.rateLimited=true;state.stop=true;}
   else (state.byPath[pathname]??=[]).push(elapsed);
   return {value,elapsed,error:null,limited:state.lastStatus===429,status:state.lastStatus};
  }catch(error){
   const elapsed=now()-started;
   // The API can also signal the limit in the body with HTTP 200, so the adapter's
   // mapped 429 is authoritative; the raw status alone would miss it.
   if(error?.status===429)state.rateLimited=true;
   if(state.rateLimited){state.stop=true;return {value:null,elapsed,error:null,limited:true,status:429};}
   if(state.stop)throw error;
   return {value:null,elapsed,error:error instanceof ServiceError?error.message:String(error?.message||error),limited:false,status:error?.status??null};
  }
 }

 return {probe,state,env};
}

/** Resolve the account token and its recent matches. Costs two requests. */
export async function locate({probe,settings,tag}){
 const account=await probe('/searchBnetAccount',null,{name:tag,token:settings.DASHEN_TOKEN,roleId:settings.DASHEN_ROLE_ID,dts:settings.DASHEN_DTS,server:settings.DASHEN_SERVER});
 const token=account.value?.customerToken;
 if(!token)return {token:null,matchIds:[]};
 const list=await probe('/customer/queryMatchList',{token,gameMode:'leisure',page:1,season:''});
 const rows=Array.isArray(list.value)?list.value:list.value?.matchList||list.value?.recentMatchList||[];
 return {token,matchIds:rows.map(m=>String(m?.matchId||'')).filter(Boolean)};
}
