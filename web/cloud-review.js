(function(root){
 const el=id=>document.getElementById(id);let current=null,busy=false,serial=0;
 function paint(review){el('aiReviewGenerate').hidden=!!review;el('aiReviewAgain').hidden=!review;el('aiReviewGenerate').disabled=busy||!current||!!current.reason;el('aiReviewAgain').disabled=busy||!current||!!current.reason;el('aiReviewText').textContent=review?.content?.review?.text||'选择一场对局，点击生成锐评。';el('aiReviewStatus').textContent=current?.reason|| (busy?'正在生成，请稍候…':review?'已显示本地保存的锐评':'手动生成 · 全场表现参考');}
 async function render(match,raw){const seq=++serial;if(!match){current=null;el('aiReviewPanel').hidden=true;return;}el('aiReviewPanel').hidden=false;const original=raw.matches.find(m=>m.mid===match.mid),subject=original?.players.filter(p=>p.name===raw.battletag)||[];const reason=!original?.hasGameData||!original.duration?'本场缺少对局详情或有效时长':subject.length!==1?'本场缺少唯一的查询账号':null;
  current={reason,tag:raw.battletag,mid:match.mid,key:null,review:null};paint();const key='review|'+await Cloud.key({tag:raw.battletag,match:original,version:'1.6-cloud.1'});const review=await Cloud.storage(key);if(seq!==serial)return;current={reason,tag:raw.battletag,mid:match.mid,key,review};paint(review);
 }
 async function wait(id,selected){for(;;){const job=await Cloud.api('/api/job/'+id);if(job.state==='done'){await Cloud.storage(selected.key,job.reviewEnvelope);if(current?.key===selected.key)current.review=job.reviewEnvelope;return;}if(['failed','cancelled'].includes(job.state))throw Error(job.message);await new Promise(r=>setTimeout(r,1500));}}
 async function generate(force=false){const selected=current;if(busy||!selected?.key||selected.reason)return;busy=true;paint(selected.review);let error=null;
  try{const value=await Cloud.api('/api/ai-review',{battletag:selected.tag,matchId:selected.mid,envelope:await Cloud.snapshot(selected.tag),force,cachedReview:selected.review,requestId:crypto.randomUUID(),reviewKey:selected.key});if(value.cached){await Cloud.storage(selected.key,value.reviewEnvelope);if(current?.key===selected.key)current.review=value.reviewEnvelope;}else await wait(value.id,selected);}
  catch(e){error=e.message;}finally{busy=false;paint(current?.review);if(error&&current?.key===selected.key)el('aiReviewStatus').textContent=error;}
 }
 el('aiReviewGenerate').onclick=()=>generate();el('aiReviewAgain').onclick=()=>generate(true);
 root.QS_REVIEW={render};
 // Resume only an already-started generation after a refresh; never initiate a model call here.
 (async()=>{try{await Cloud.boot();const state=await Cloud.api('/api/latest');if(state.activeAI){busy=true;const job=await Cloud.api('/api/job/'+state.activeAI);if(job.reviewKey)await wait(job.id,{key:job.reviewKey});busy=false;paint(current?.review);}}catch(e){busy=false;if(current)el('aiReviewStatus').textContent=e.message;}})();
})(window);
