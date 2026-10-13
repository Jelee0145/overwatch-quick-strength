(function(root){
'use strict';
const el=id=>document.getElementById(id),results=new Map(),loaded=new Set(),loading=new Set();
let current=null,busy=false,keyContinuation=null;
async function request(path,body){
 if(location.protocol==='file:')throw Error('AI锐评需要本地服务，请启动工具');
 const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 let data;try{data=await response.json();}catch{throw Error('锐评服务返回格式异常');}
 if(!response.ok)throw Error(data.error||'锐评请求失败');return data;
}
function setStatus(text,error=false){el('aiReviewStatus').textContent=text;el('aiReviewStatus').classList.toggle('error',error);}
function paint(){
 const review=current&&results.get(current.key);
 el('aiReviewText').textContent=review?.text||'看看谁在尽力，谁在让队友坐牢。';
 el('aiReviewText').classList.toggle('muted',!review);
 el('aiReviewGenerate').hidden=!!review;el('aiReviewAgain').hidden=!review;
 el('aiReviewGenerate').disabled=busy||!current||!!current.reason;el('aiReviewAgain').disabled=busy||!current||!!current.reason;
 el('aiReviewGenerate').textContent=busy?'生成中…':'生成锐评';el('aiReviewAgain').textContent=busy?'生成中…':'重新锐评';
 if(current?.reason)setStatus(current.reason);
 else if(busy)setStatus('AI正在看全场数据，生成期间请稍候…');
 else if(review)setStatus(review.cached?'已显示本场保存的锐评':'本场锐评已生成');
 else setStatus('手动生成 · 全场表现参考 · DeepSeek V4.1 Flash');
}
function render(match,raw){
 if(!match){current=null;el('aiReviewPanel').hidden=true;return;}
 el('aiReviewPanel').hidden=false;
 const players=match.combatPlayers||match.players,subject=players.filter(p=>p.name===raw.battletag);
 const reason=!match.hasGameData||!match.duration?'本场缺少对局详情或有效时长，暂不能锐评':subject.length!==1?'本场缺少唯一的查询账号记录，暂不能锐评':!Object.values(subject[0].stats||{}).some(Number.isFinite)?'本人战斗数据尚未返回，暂不能锐评':null;
 const ratings=players.map(p=>({hero:p.hero,score:p.performance?.score??null,grade:p.performance?.grade??null,
  coverage:p.performance?.coverage??null,profile:p.performance?.profileName||'通用定位',reason:p.performance?.reason||null,
  groups:(p.performance?.groups||[]).map(g=>({label:g.label,score:g.score,weight:g.weight,missing:g.missing})),
  resource:p.performance?.resource?Object.fromEntries(['applied','delta','sensitivity','confidence','expectedHealing','expectedDamage','healRatio','damageRatio','adjustedHealRatio','contribution','peerContribution','label','reason'].map(k=>[k,p.performance.resource[k]])):null}));
 const body={battletag:raw.battletag,matchId:match.mid,ratings};
 const key=JSON.stringify({body,duration:match.duration,stats:players.map(p=>p.stats),result:match.ret,scores:[match.teamScore,match.opponentScore]});
 current={key,body,reason};paint();
 // Cache lookup never invokes the model. Re-rendering the chart does not bill.
 if(!reason&&location.protocol!=='file:'&&!loaded.has(key)&&!loading.has(key)){
  loading.add(key);
  request('/api/ai-review',{...body,cacheOnly:true}).then(data=>{
   loaded.add(key);if(data.review&&!results.has(key))results.set(key,data.review);if(current?.key===key)paint();
  }).catch(()=>{}).finally(()=>loading.delete(key));
 }
}
function openKeyDialog(continuation=null){
 keyContinuation=continuation;el('aiKeyInput').value='';el('aiKeyStatus').textContent='密钥仅加密保存到本机，不回填到网页。';
 el('aiKeyDialog').showModal();el('aiKeyInput').focus();
}
async function generate(force=false){
 const selected=current;if(busy||!selected||selected.reason)return;
 busy=true;paint();
 try{
  const state=await request('/api/ai-key');
  if(!state.configured){busy=false;paint();openKeyDialog(()=>{if(current?.key===selected.key)generate(force);});return;}
  const review=await request('/api/ai-review',{...selected.body,force});results.set(selected.key,review);loaded.add(selected.key);
  if(current?.key===selected.key)paint();
 }catch(error){if(current?.key===selected.key){paint();setStatus(error.message,true);}}
 finally{busy=false;if(current?.key===selected.key){const message=el('aiReviewStatus').textContent,isError=el('aiReviewStatus').classList.contains('error');paint();if(isError)setStatus(message,true);}else paint();}
}
function init(){
 el('aiReviewGenerate').onclick=()=>generate(false);el('aiReviewAgain').onclick=()=>generate(true);
 el('aiReviewSettings').onclick=()=>openKeyDialog();
 el('aiKeyCancel').onclick=()=>{el('aiKeyInput').value='';keyContinuation=null;el('aiKeyDialog').close();};
 el('aiKeyDialog').addEventListener('cancel',()=>{el('aiKeyInput').value='';keyContinuation=null;});
 el('aiKeyDialog').addEventListener('close',()=>{el('aiKeyInput').value='';});
 el('aiKeyForm').onsubmit=async event=>{
  event.preventDefault();el('aiKeySave').disabled=true;
  let key=el('aiKeyInput').value.trim();el('aiKeyInput').value='';
  try{await request('/api/ai-key/save',{key});const resume=keyContinuation;keyContinuation=null;el('aiKeyDialog').close();setStatus('DeepSeek 密钥已加密保存');if(resume)resume();}
  catch(error){el('aiKeyStatus').textContent=error.message;}
  finally{key='';el('aiKeySave').disabled=false;}
 };
 el('aiKeyClear').onclick=async()=>{
  el('aiKeyClear').disabled=true;try{await request('/api/ai-key/clear',{});el('aiKeyInput').value='';keyContinuation=null;el('aiKeyStatus').textContent='本机 DeepSeek 密钥已清除';setStatus('密钥已清除；已有锐评保留，下次生成需重新填写');}
  catch(error){el('aiKeyStatus').textContent=error.message;}finally{el('aiKeyClear').disabled=false;}
 };
}
root.QS_REVIEW={render};init();
})(window);
