import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const script=await readFile(new URL('../web/events.js',import.meta.url),'utf8');
const model=await readFile(new URL('../web/events-model.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const epoch=Date.parse('2026-10-24T08:00:00Z');
const match=(overrides={})=>({id:'test',startsAt:new Date(epoch+600000).toISOString(),status:'scheduled',teams:[{name:'Alpha',shortName:'A'},{name:'Beta',shortName:'B'}],scores:[null,null],tournament:'Test Cup',region:'中国',series:'owcs',sourceUrl:'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/China',...overrides});
const snapshot=(overrides={})=>({matches:[match()],updatedAt:new Date(epoch).toISOString(),refreshIntervalSeconds:60,nextRefreshAt:new Date(epoch+60000).toISOString(),...overrides});
function harness(handler=()=>snapshot()){
 let now=epoch,sequence=0;const timers=new Map(),nodes=new Map(),listeners={},documentListeners={},calls=[];
 function element(tag='div'){
  let ownText='';const node={tagName:tag,children:[],attributes:{},value:'',hidden:false,disabled:false,events:{},className:'',classList:{add(){}},get childElementCount(){return this.children.length;},get textContent(){return ownText+this.children.map(n=>typeof n==='string'?n:n.textContent).join('');},set textContent(value){ownText=String(value);this.children=[];},setAttribute(name,value){this.attributes[name]=String(value);},append(...items){this.children.push(...items);},replaceChildren(...items){ownText='';this.children=items;},addEventListener(type,fn){(this.events[type]||=[]).push(fn);}};return node;
 }
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};get('eventsSeries').value='owcs';
 const document={visibilityState:'visible',getElementById:get,createElement:element,querySelectorAll:()=>[],addEventListener(type,fn){(documentListeners[type]||=[]).push(fn);}};
 const window={EventReminders:{state:{ready:true,enabled:true,pending:false,deviceEnabled:true,reservations:[]}},addEventListener(type,fn){(listeners[type]||=[]).push(fn);}};
 const context={window,document,Intl,URL,URLSearchParams,Date:class extends Date{static now(){return now;}},Option:function(text,value){const option=element('option');option.textContent=text;option.value=value;return option;},setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,at:now+Number(ms),interval:false});return id;},clearTimeout(id){timers.delete(id);},setInterval(fn,ms){const id=++sequence;timers.set(id,{fn,at:now+Number(ms),interval:Number(ms)});return id;},clearInterval(id){timers.delete(id);},Cloud:{boot:()=>Promise.resolve(),api:async(url,body)=>{const call={url,method:body===undefined?'GET':'POST',at:now};calls.push(call);return handler(call,calls.length);}}};
 vm.runInNewContext(model,context);vm.runInNewContext(script,context);
 const dispatch=(source,type,event={})=>{for(const fn of source[type]||[])fn({type,...event});};
 return {calls,get,timers,window,document,async advance(ms){const end=now+ms;for(;;){let selected;for(const [id,timer]of timers)if(timer.at<=end&&(!selected||timer.at<selected.timer.at))selected={id,timer};if(!selected)break;const{id,timer}=selected;now=timer.at;if(timer.interval)timer.at+=timer.interval;else timers.delete(id);timer.fn();await flush();}now=end;await flush();},async visible(value){document.visibilityState=value?'visible':'hidden';dispatch(documentListeners,'visibilitychange');await flush();},async lifecycle(type){dispatch(listeners,type,{persisted:true});await flush();},async change(id,value){get(id).value=value;dispatch(get(id).events,'change');await flush();},async clickRefresh(){get('eventsRefresh').onclick();await flush();},async submit(){get('eventsFilters').onsubmit({preventDefault(){}});await flush();}};
}

test('visible page polls GET shared cache on cadence, retains initial manual refresh and user filters',async()=>{
 const app=harness();await flush();
 assert.deepEqual(app.calls.map(c=>c.method),['GET','POST']);
 app.get('eventsTeam').value='Alpha';app.get('eventsRegion').value='中国';app.get('eventsTournament').value='Test Cup';
 await app.advance(59999);assert.equal(app.calls.length,2);
 await app.advance(1);assert.equal(app.calls.length,3);assert.equal(app.calls[2].method,'GET');
 assert.equal(app.get('eventsTeam').value,'Alpha');assert.equal(app.get('eventsRegion').value,'中国');assert.equal(app.get('eventsTournament').value,'Test Cup');
 await app.advance(120000);assert.ok(app.calls.slice(2).every(c=>c.method==='GET'));
 assert.equal([...app.timers.values()].filter(t=>!t.interval).length,1,'only one polling timeout remains');
});

test('poll cadence is clamped to 30–60 seconds, not every local render tick',async()=>{
 for(const [interval,expected]of[[1,30000],[300,60000],[900,60000]]){
  const app=harness(()=>snapshot({refreshIntervalSeconds:interval}));await flush();await app.advance(expected-1);assert.equal(app.calls.length,2);await app.advance(1);assert.equal(app.calls.length,3);
 }
});

test('hidden pages stop polling, visible and BFCache restoration resume GET without duplicate timers',async()=>{
 const app=harness();await flush();await app.visible(false);await app.advance(300000);assert.equal(app.calls.length,2);
 await app.visible(true);assert.equal(app.calls.length,3);assert.equal(app.calls.at(-1).method,'GET');
 await app.lifecycle('pagehide');assert.equal(app.timers.size,0);await app.advance(300000);assert.equal(app.calls.length,3);
 await app.lifecycle('pageshow');assert.equal(app.calls.length,4);await app.advance(60000);assert.equal(app.calls.length,5);
 assert.equal([...app.timers.values()].filter(t=>!t.interval).length,1);assert.equal([...app.timers.values()].filter(t=>t.interval).length,1);
});

test('pending backfill uses only its retry timer, pauses hidden and resumes the selected query',async()=>{
 let pending=false;const app=harness(call=>pending?{state:'pending',message:'服务器正在补查',retryAfter:10}:snapshot());await flush();pending=true;
 await app.change('eventsFrom','2026-10-23');await app.change('eventsTo','2026-10-24');await app.advance(400);
 assert.equal(app.calls.length,3);assert.match(app.calls.at(-1).url,/from=2026-10-23/);
 await app.advance(9999);assert.equal(app.calls.length,3);await app.advance(1);assert.equal(app.calls.length,4);
 assert.equal([...app.timers.values()].filter(t=>!t.interval).length,1);
 await app.visible(false);await app.advance(60000);assert.equal(app.calls.length,4);
 pending=false;await app.visible(true);assert.equal(app.calls.length,5);assert.match(app.calls.at(-1).url,/to=2026-10-24/);assert.equal(app.calls.at(-1).method,'GET');
});

test('automatic polling does not overlap a slow response or override manual cooldown feedback',async()=>{
 let release,slow=false;const app=harness(()=>slow?new Promise(resolve=>{release=resolve;}):snapshot());await flush();slow=true;
 await app.advance(60000);assert.equal(app.calls.length,3);await app.advance(180000);assert.equal(app.calls.length,3,'one request stays in flight');
 release(snapshot({refreshError:'请求间隔未到，正在显示缓存。',retryAfter:25}));await flush();
 assert.match(app.get('eventsNotice').textContent,/显示缓存/);assert.match(app.get('eventsNotice').textContent,/25 秒后重试/);assert.equal(app.get('eventsNotice').hidden,false);
 assert.equal(app.get('eventsRefresh').textContent,'刷新赛程');
 slow=false;await app.advance(60000);assert.equal(app.calls.length,4);assert.equal(app.calls.at(-1).method,'GET');
});

test('a stale in-flight query cannot replace a newer filter result',async()=>{
 let resolveOld,stale=false;const app=harness(call=>stale&&call.url.includes('from=2026-10-22')?new Promise(resolve=>{resolveOld=resolve;}):snapshot({coverage:'new result'}));await flush();stale=true;
 await app.change('eventsFrom','2026-10-22');await app.change('eventsTo','2026-10-24');await app.advance(400);
 await app.change('eventsFrom','2026-10-23');await app.advance(400);assert.equal(app.get('eventsCoverage').textContent,'new result');
 resolveOld(snapshot({coverage:'OLD result'}));await flush();assert.equal(app.get('eventsCoverage').textContent,'new result');assert.equal(app.get('eventsFrom').value,'2026-10-23');
});

test('live and scheduled numeric series scores render; unknown scores do not become zero',async()=>{
 for(const [status,scores,label,score]of[['live',[2,1],'进行中','2 : 1'],['scheduled',[1,0],'未开始','1 : 0'],['scheduled',[null,null],'未开始','VS']]){
  const app=harness(()=>snapshot({matches:[match({status,scores})]}));await flush();const text=app.get('eventsList').textContent;assert.match(text,new RegExp(label));assert.ok(text.includes(score));
 }
});

test('refresh preserves selected filter values even when new partial data lacks them',async()=>{
 let empty=false;const app=harness(()=>snapshot({matches:empty?[]:[match()]}));await flush();app.get('eventsTournament').value='Test Cup';app.get('eventsRegion').value='中国';empty=true;await app.advance(60000);
 assert.equal(app.get('eventsTournament').value,'Test Cup');assert.equal(app.get('eventsRegion').value,'中国');
});
test('manual refresh cancels a queued filter debounce instead of starting overlapping requests',async()=>{
 const app=harness();await flush();await app.change('eventsFrom','2026-10-23');await app.change('eventsTo','2026-10-24');await app.clickRefresh();
 const count=app.calls.length;assert.equal(app.calls.at(-1).method,'POST');await app.advance(400);assert.equal(app.calls.length,count);
});

test('hiding before a filter debounce pauses it and restores the latest query without a stuck busy state',async()=>{
 const app=harness();await flush();await app.change('eventsFrom','2026-10-23');await app.change('eventsTo','2026-10-24');await app.visible(false);await app.advance(60000);assert.equal(app.calls.length,2);
 await app.visible(true);assert.equal(app.calls.length,3);assert.match(app.calls.at(-1).url,/from=2026-10-23/);assert.equal(app.calls.at(-1).method,'GET');
});
