import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const bundle=JSON.parse(await readFile('plugins/astrbot_plugin_owqs_api/website.json','utf8'));

function capture(kind,review=''){
 const elements=new Map();
 const element=id=>{
  if(!elements.has(id))elements.set(id,{
   id,hidden:false,textContent:'',innerHTML:'',style:{},dataset:{},
   classList:{remove(){},add(){},toggle(){}},setAttribute(){},removeAttribute(){},
   querySelectorAll(){return[];},querySelector(){return null;},
  });
  const value=elements.get(id);
  Object.defineProperty(value,'firstChild',{configurable:true,get:()=>value._firstChild||(value._firstChild={textContent:''})});
  return value;
 };
 const match={
  mid:'fixture-1',t:1000,ret:1,mapGuid:'map',mean:2200,observedMean:2200,estimateSource:'',known:[{score:2200}],
  teamScore:2,opponentScore:1,duration:600,hasGameData:true,resourceDataChecked:true,
  players:[{name:'Fixture#100',side:'T',hero:'207165582859042818',role:'dps',score:2200,stats:{kill:20,assist:8,death:4,finalHit:10,heroDamage:10000,cure:null,resistDamage:6000,healingTaken:3000,damageTaken:8000},performance:{grade:'A',score:82.7,coverage:.9,profileName:'通用定位',reason:'',hero:'死神',reference:'参考'}}],
 };
 const input={kind,raw:{battletag:'Fixture#100',matches:[match]},match,options:{limit:10},index:1,mapName:'未知地图',review};
 const context={console,document:{getElementById:element,querySelectorAll:()=>[]},queueMicrotask:fn=>fn(),dispatchEvent(){},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},INPUT:input};
 context.window=context;
 vm.createContext(context);
 vm.runInContext(bundle.script,context);
 return {elements};
}

test('Bot captures use the final website DOM, stylesheet and player renderer',async()=>{
 const page=await readFile('public/tools/strength.html','utf8');
 const css=page.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
 assert.equal(bundle.css,await readFile('public'+css,'utf8'));
 assert.ok(page.includes(bundle.data));assert.ok(page.includes(bundle.review));
 assert.equal((bundle.data.match(/<th[ >]/g)||[]).length,13);
 assert.ok(bundle.script.includes('function showPlayers('));
 assert.ok(bundle.script.includes('function performanceCell('));
 assert.ok(bundle.script.includes('对局记录缺少部分游戏数据；不会自动补查'));
 assert.ok(bundle.script.includes("$('aiReviewText').textContent=INPUT.review"));
 assert.ok(!bundle.script.includes('loadGameData(m)'));
});

test('generated Bot capture scripts execute for data and review branches',()=>{
 const data=capture('data');
 assert.match(data.elements.get('players').innerHTML,/Fixture#100/);
 assert.equal(data.elements.get('matchSelect').firstChild.textContent,'第 1 场 · 未知地图');
 const review=capture('review','一句锐评');
 assert.equal(review.elements.get('aiReviewText').textContent,'一句锐评');
 assert.equal(review.elements.get('aiReviewPanel').hidden,false);
});
