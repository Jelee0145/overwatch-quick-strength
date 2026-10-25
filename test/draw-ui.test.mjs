import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../web/draw.js',import.meta.url),'utf8');
const engine=await readFile(new URL('../web/draw-engine.js',import.meta.url),'utf8');
const heroes=JSON.parse(await readFile(new URL('../web/draw/heroes.json',import.meta.url),'utf8')).heroes.map(h=>({...h,portrait:'/fixture/'+h.id+'.png'}));
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function setup(){
 const nodes=new Map(),saved=new Map();let verificationError=null,storageError=null;
 function node(tag='div'){
  const classes=new Set();return {tagName:tag,children:[],dataset:{},style:{},textContent:'',disabled:false,hidden:false,offsetLeft:0,offsetWidth:100,id:'',classList:{add(...v){v.forEach(x=>classes.add(x));},remove(...v){v.forEach(x=>classes.delete(x));},toggle(x,value){if(value)classes.add(x);else classes.delete(x);}},get firstElementChild(){return this.children[0];},append(...v){this.children.push(...v);},replaceChildren(...v){this.children=v;this.children.forEach((x,i)=>{x.offsetLeft=i*100;});},setAttribute(){},querySelector(selector){return selector==='img'?this.children.find(x=>x.tagName==='img'):null;},getBoundingClientRect(){return {height:150};},animate(){return {finished:Promise.resolve(),cancel(){}};},showModal(){},close(){}};
 }
 const get=id=>{if(!nodes.has(id)){const item=node();item.id=id;nodes.set(id,item);}return nodes.get(id);};
 get('drawButton').append(node('span'));
 const modes=['wheel','card','slot'].map(mode=>Object.assign(node('button'),{dataset:{mode}}));
 const roles=['all','重装','输出','支援'].map(role=>Object.assign(node('button'),{dataset:{role}}));
 const document={getElementById:get,createElement:node,querySelectorAll(selector){if(selector==='button[data-mode]')return modes;if(selector==='[data-role]')return roles;if(selector.includes('#drawButton'))return [...modes,...roles,get('drawButton'),get('clearDrawHistory')];return [];}};
 const window={},context={window,document,HERO_DRAW_DATA:{heroes},matchMedia:()=>({matches:true}),Cloud:{boot:()=>Promise.resolve(),verify:async()=>{if(verificationError)throw Error(verificationError);},storage:async(key,value)=>{if(value===undefined)return saved.get(key);if(storageError&&key==='hero-draw-history')throw Error(storageError);saved.set(key,value);}},Image:class{async decode(){}},ResizeObserver:class{observe(){}},DOMMatrixReadOnly:class{m41=0;},getComputedStyle:()=>({transform:'none'}),requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout:fn=>queueMicrotask(fn),crypto:{getRandomValues:a=>a.fill(0)},confirm:()=>true};
 vm.runInNewContext(engine,context);context.HeroDrawEngine=window.HeroDrawEngine;vm.runInNewContext(code,context);
 return {get,saved,async mode(value){modes.find(x=>x.dataset.mode===value).onclick();await settle();},async role(value){roles.find(x=>x.dataset.role===value).onclick();await settle();},async draw(){await get('drawButton').onclick();await settle();},failVerify(value){verificationError=value;},failSave(value){storageError=value;}};
}
test('draw idle and selection changes rely on the selected controls rather than instruction prose',async()=>{
 const app=setup();await settle();assert.equal(app.get('resultHint').textContent,'');assert.equal(app.get('resultName').textContent,'');
 await app.mode('card');assert.equal(app.get('resultHint').textContent,'');await app.role('支援');assert.equal(app.get('resultHint').textContent,'');assert.match(app.get('poolCount').textContent,/^\d+ 位英雄$/);
});
test('a completed draw shows the hero without an extra introductory label',async()=>{
 const app=setup();await settle();await app.draw();assert.ok(app.get('resultName').textContent);assert.ok(app.get('resultRole').textContent);assert.equal(app.get('resultHint').textContent,'');assert.equal(app.get('drawButton').disabled,false);assert.equal(app.saved.get('hero-draw-history').length,1);
});
test('draw errors and failed history saves remain visible and retry stays available',async()=>{
 const failed=setup();await settle();failed.failVerify('登录已失效');await failed.draw();assert.equal(failed.get('resultHint').textContent,'登录已失效');assert.equal(failed.get('drawButton').disabled,false);
 const unsaved=setup();await settle();unsaved.failSave('不可写');await unsaved.draw();assert.ok(unsaved.get('resultName').textContent);assert.match(unsaved.get('resultHint').textContent,/记录保存失败/);assert.equal(unsaved.get('drawButton').disabled,false);
});