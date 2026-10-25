import {Fault,json,digest,verifySnapshot} from '../security.mjs';
import {authenticate,taskClient,requireMethod,jsonInput,operationKey} from './context.mjs';
import {normalizeQueryOptions} from '../query/options.mjs';
import {readArchive} from '../history/store.mjs';
import {analyzeArchive,selectArchiveMatch,selectArchiveEnvelope} from '../history/analysis.mjs';
import {webAnalysisView,requireSlimFlag} from '../history/view.mjs';
import {handleHistoryAnalysis} from './history.mjs';
import {listEvents,handleReminder} from '../events/application.mjs';
import {analysisService} from '../services/runtime.mjs';
import {analyzeResult} from './analysis.mjs';
import {renderApiChart,compactAnalysis} from './chart.mjs';
export const apiVersion='1.1';
export {analysisResponseCache} from './history.mjs';
const capabilities=(env,auth)=>({history:auth.tier!=='free',analysis:auth.tier!=='free',idempotency:true,sharedQuota:true,reservations:auth.tier!=='free'&&!!env.REMINDERS,webPush:auth.tier!=='free'&&!!env.REMINDERS});
function personal(auth){if(auth.tier==='free')throw new Fault('免费服务账号不支持个人历史或预约',403);}
async function taskArchive(call,auth,env,id){
 if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new Fault('任务标识无效');
 const job=await call('/status',{id,compact:false});if(job.kind!=='query'||job.state!=='done'||!job.envelope)throw new Fault('查询结果尚不可用',409);
 const raw=await verifySnapshot(job.envelope,auth.user.id,env),batch=await digest(JSON.stringify(job.envelope));
 return {job,archive:{tag:raw.battletag,scope:{server:env.DASHEN_SERVER,dts:env.DASHEN_DTS},batches:{[batch]:job.envelope}}};
}

// Ordered descriptors preserve exact paths, prefix actions, and parameter matching.
const routes=[
 {
  match:path=>path==='/api/v1/account',
  async handle({request,env,auth,call}){requireMethod(request,'GET');return json({...await call('/api-profile'),tier:auth.tier||'standard',apiVersion,capabilities:capabilities(env,auth)});}
 },
 {
  match:path=>path==='/api/v1/query',
  async handle({request,auth,call}){
   requireMethod(request,'POST');const input=await jsonInput(request),options=normalizeQueryOptions(input);options.requestId=operationKey(request,input);
   if(auth.tier==='free')options.syncHistory=false;
   const created=await call('/api-query',options);return json({...created,status:'/api/v1/jobs/'+created.id});
  }
 },
 {
  match:path=>path==='/api/v1/jobs',
  async handle({request,call}){
   requireMethod(request,'GET');const {tasks}=await call('/active');return json({tasks,jobs:tasks,activeJob:tasks.find(t=>t.kind==='query')?.id||null,activeAI:tasks.find(t=>t.kind==='ai')?.id||null,result:null});
  }
 },
 {
  match:path=>path==='/api/v1/history'||path==='/api/v1/history/accounts',
  async handle({request,path,auth,call}){
   personal(auth);if(path.endsWith('/accounts')){requireMethod(request,'GET');return json(await call('/history',{action:'list'}));}
   requireMethod(request,'POST');return json(await call('/history',await jsonInput(request)));
  }
 },
 {
  match:path=>path==='/api/v1/history/analysis',
  handle:handleHistoryAnalysis
 },
 {
  match:path=>path==='/api/v1/matches/detail'||path==='/api/v1/matches/review',
  async handle({request,env,path,auth,call}){
   personal(auth);requireMethod(request,'POST');const input=await jsonInput(request),ref=input.ref||input,archive=ref.sourceJob?(await taskArchive(call,auth,env,ref.sourceJob)).archive:await readArchive(call,auth.user.id,env,ref.battletag||ref.tag,ref.revision);
   if(ref.sourceJob&&((ref.tag||ref.battletag)&&archive.tag!==(ref.tag||ref.battletag)))throw new Fault('查询结果账号不匹配',409);
   const selectionOptions={...input.options,...(ref.revision?{revision:ref.revision}:{})};
   if(path.endsWith('/detail'))return json(await selectArchiveMatch(archive,ref.mid,selectionOptions,{slim:requireSlimFlag(input)}));
   const selected=await selectArchiveEnvelope(archive,ref.mid,selectionOptions);
   if(!analysisService.analyzeBatch(selected.envelope.content.data,input.options||{}).matches.some(match=>match.mid===ref.mid))throw new Fault('历史对局不存在或不属于当前模式',404);
   return json(await call('/ai-review',{battletag:archive.tag,matchId:ref.mid,envelope:selected.envelope,requestId:operationKey(request,input),force:input.force,cachedReview:input.cachedReview,reviewKey:input.reviewKey}));
  }
 },
 {
  match:path=>path==='/api/v1/reviews',
  async handle({request,call}){
   requireMethod(request,'POST');const input=await jsonInput(request);return json(await call('/ai-review',{...input,requestId:operationKey(request,input)}));
  }
 },
 {
  match:path=>path==='/api/v1/events/reminders'||path.startsWith('/api/v1/events/reminders/'),
  async handle({request,env,path,auth,mutation}){
   personal(auth);const action=path==='/api/v1/events/reminders'?'list':path.slice('/api/v1/events/reminders/'.length);requireMethod(request,action==='list'?'GET':'POST');
   return json(await handleReminder(env,auth.user.id,action,mutation?await jsonInput(request):{}));
  }
 },
 {
  match:path=>path==='/api/v1/events'||path==='/api/v1/events/refresh',
  async handle({request,env,url,path,auth}){
   const refresh=path.endsWith('/refresh');requireMethod(request,refresh?'POST':'GET');
   const params=new URLSearchParams(url.searchParams),paginate=params.get('paginate')!=='0';params.delete('paginate');
   const {response,value}=await listEvents(env,auth.user.id,params,{refresh,paginate});return response||json(value);
  }
 },
 {
  match:path=>/^\/api\/v1\/jobs\/([a-f0-9]{64})\/analysis$/.exec(path),
  async handle({request,env,auth,call},jobAnalysis){
   requireMethod(request,'POST');const input=await jsonInput(request),{job,archive}=await taskArchive(call,auth,env,jobAnalysis[1]);
   if(input.battletag&&input.battletag!==archive.tag)throw new Fault('查询结果账号不匹配',409);
   const view=await analyzeArchive(archive,input.options||{});view.sourceJob=jobAnalysis[1];view.archiveWarning=job.archiveWarning||null;view.matchRefs=view.matchRefs.map(ref=>({...ref,sourceJob:jobAnalysis[1]}));return json(requireSlimFlag(input)?webAnalysisView(view):view);
  }
 },
 {
  match:path=>/^\/api\/v1\/jobs\/([a-f0-9]{64})\/matches\/([0-9]+)(\/review)?$/.exec(path),
  async handle({request,call},selected){const review=!!selected[3];requireMethod(request,review?'POST':'GET');const input=review?await jsonInput(request):{};return json(await call(review?'/api-match-review':'/api-match',{id:selected[1],index:Number(selected[2]),requestId:review?operationKey(request,input):undefined}));}
 },
 {
  match:path=>/^\/api\/v1\/reviews\/([a-f0-9]{64})$/.exec(path),
  async handle({request,call},reviewId){requireMethod(request,'GET');const status=await call('/status',{id:reviewId[1]});if(status.kind!=='ai')throw new Fault('锐评任务不存在',404);return json({id:status.id,state:status.state,message:status.message,match:status.reviewMatch,review:status.state==='done'?status.review:undefined,quota:status.quota||(status.state==='done'?'charged':status.state==='failed'?'released':'reserved')});}
 },
 {
  match:path=>/^\/api\/v1\/jobs\/([a-f0-9]{64})(\/(cancel|resume|cache))?$/.exec(path),
  async handle({request,url,call,assets},match){
   const id=match[1];if(match[3]){requireMethod(request,'POST');const input=match[3]==='cancel'?{}:await jsonInput(request);return json(await call('/'+match[3],{...input,id}));}requireMethod(request,'GET');
   const rendering=url.searchParams.get('render');if(rendering!==null&&rendering!=='svg')throw new Fault('图片格式仅支持 svg');
   const status=await call('/status',{id,compact:false});
   if(status.kind==='ai')return json(status);
   const out={...status,options:status.apiOptions||null,quota:status.quota||(['failed','cancelled'].includes(status.state)?'released':status.state==='done'?'charged':'reserved')};
   if(status.state==='done'){
    out.battletag=status.result.battletag;try{out.analysis=analyzeResult(status.result,status.apiOptions||{});}catch{out.analysis=null;out.analysisError='分析生成失败';}
    if(rendering==='svg')try{out.chart=await renderApiChart(status.result,status.apiOptions||{},assets);}catch{out.chart=null;out.chartError='图表生成失败，可使用已有分析结果';}
    if(url.searchParams.get('compact')==='1'){delete out.result;delete out.envelope;delete out.cacheRecords;delete out.queryIndex;if(out.analysis)out.analysis=compactAnalysis(out.analysis);}
   }
   return json(out);
  }
 }
];

export async function apiV1(request,env,url){
 const auth=await authenticate(request,env),call=taskClient(env,auth),path=url.pathname,mutation=request.method==='POST';
 const assets=env.RENDERER_ASSETS||env.ASSETS;
 const context={request,env,url,auth,call,path,mutation,assets,personal};
 for(const route of routes){const match=route.match(path);if(match)return route.handle(context,match);}
 throw new Fault('接口不存在',404);
}
