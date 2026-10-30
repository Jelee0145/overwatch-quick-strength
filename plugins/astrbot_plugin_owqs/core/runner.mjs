import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMatchService,createChartService,ServiceError} from '../../../backend/src/services/index.mjs';
import {analysisService,dataService} from '../../../backend/src/services/runtime.mjs';
import {upstream} from '../../../backend/src/adapters/dashen.mjs';
import {canonical,digest,token} from '../../../backend/src/security.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const analysisOptions={side:'all',strategy:'legacy',estimate:true};

export function chartModel(snapshot,pool=''){
 const options={...analysisOptions,pool},raw=dataService.normalize(snapshot),all=analysisService.analyzeBatch(raw,options);
 return analysisService.summarize(raw,all.matches.slice(-10),options);
}

export async function renderSnapshot(snapshot,assetRoot,pool=''){
 const model=chartModel(snapshot,pool);
 if(!model.matches.length)throw new ServiceError('该账号暂无可展示的快速对局',404);
 const manifest=JSON.parse(await readFile(path.join(assetRoot,'manifest.json'),'utf8'));
 const memo=new Map();
 const embed=async url=>{
  if(!url)return '';
  if(!/^\/media\/(maps|icons)\/[a-f0-9]{20}\.webp$/.test(url))throw Error('Invalid packaged media path');
  if(!memo.has(url))memo.set(url,readFile(path.join(assetRoot,url.slice(1))).then(bytes=>'data:image/webp;base64,'+bytes.toString('base64')));
  return memo.get(url);
 };
 const art=Object.fromEntries(await Promise.all([...new Set(model.matches.map(m=>m.mapGuid))].map(async id=>[id,await embed(manifest.maps[id]?.export)])));
 const rankArt=Object.fromEntries(await Promise.all(Object.entries(manifest.ranks).map(async([id,url])=>[id,await embed(url)])));
 const maps=Object.fromEntries(Object.entries(manifest.maps).map(([id,m])=>[id,{name:m.name}]));
 const chart=createChartService({core:globalThis.QS,maps,rankArt,avatar:await embed(manifest.avatar)});
 return {svg:chart.render(model,{art,title:'狸狸天眼查 · 快速强度图'}),displayed:model.matches.length,summary:model.summary};
}

/** Private stdio protocol. Cache output contains account tokens; never log it. */
export async function runJob(input,{provider=upstream,emit=()=>{},sleep=delay,assetRoot=path.join(import.meta.dirname,'assets'),serviceOptions={}}={}){
 if(input?.version!==1)throw new ServiceError('插件核心协议版本不匹配');
 const env=Object.fromEntries(['DASHEN_SERVER','DASHEN_DTS','DASHEN_ROLE_ID','DASHEN_TOKEN'].map(k=>[k,String(input.credentials?.[k]||'').trim()]));
 if(Object.values(env).some(v=>!v))throw new ServiceError('请管理员先配置完整的大神查询凭证',503);
 const {tag,limit=10,mode='fast',pool=''}=input.request||{};
 if(![5,10,20].includes(limit)||!['fast','slow'].includes(mode))throw new ServiceError('场数仅支持 5/10/20，模式仅支持快/慢');
 if(!['','55','66'].includes(pool))throw new ServiceError('对局模式仅支持 5v5（55）、6v6（66）或留空');
 const service=createMatchService({provider,pick:analysisService.pick,data:dataService,digest,canonical,createId:token,sleep,
  playerIdentity:async(context,customerToken)=>customerToken?createHmac('sha256',context.DASHEN_TOKEN).update(canonical([context.DASHEN_SERVER,context.DASHEN_DTS,context.DASHEN_ROLE_ID,customerToken])).digest('hex'):null,
  ...serviceOptions});
 const scope=await service.accountScope(env);
 const prior=input.prior?.scope===scope&&input.prior?.snapshot?.battletag===tag?input.prior:null;
 const state=service.createQuery(tag,limit,prior?.snapshot||{matches:[]},prior?.accounts||[],{supplementOtherMatches:mode==='slow',pool});
 let previous='';
 while(state.phase!=='done'){
  try{
   await service.runQuery(state,env,{budgetMs:4000,checkpoint:()=>{
    const p=service.queryProgress(state),key=JSON.stringify(p);
    if(key!==previous){previous=key;emit({type:'progress',...p});}
   }});
  }catch(error){
   if(error.status!==429)throw error;
   emit({type:'paused',message:'大神接口限流，30 秒后继续查询',retryAfter:30});
   await sleep(30000);
  }
 }
 const snapshot=state.result;
 snapshot.source='网易大神 · AstrBot 独立查询';
 const picture=await renderSnapshot(snapshot,assetRoot,pool);
 return {type:'done',...picture,cache:{scope,snapshot,accounts:service.accountRecords(state)}};
}

export async function cli(){
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
 try{
  if(Number(process.versions.node.split('.')[0])<22)throw new ServiceError('插件需要 Node.js 22 或更新版本',503);
  if(process.argv.includes('--check')){await readFile(path.join(import.meta.dirname,'assets/manifest.json'));emit({type:'ready',version:1});return;}
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>32*1024*1024)throw new ServiceError('本地查询缓存过大，请管理员清理插件缓存');chunks.push(chunk);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  emit(await runJob(input,{emit}));
 }catch(error){
  // Only approved domain messages cross into the conversation. No stack/URL/token.
  emit({type:'error',status:error instanceof ServiceError?error.status:500,message:error instanceof ServiceError?error.message:'查询核心执行失败，请管理员检查运行依赖和插件素材'});
  process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await cli();
