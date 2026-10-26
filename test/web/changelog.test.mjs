import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {collectNotes} from '../../scripts/build/release-notes.mjs';
const source=await readFile(new URL('../../web/changelog.js',import.meta.url),'utf8'),tick=()=>new Promise(resolve=>setImmediate(resolve));
test('feature and fix commits update changelog version; maintenance does not; Chinese release descriptions take priority',()=>{
 const initial=[{id:'old',date:'2026-10-14',title:'历史',items:['旧记录']}],base=collectNotes([],initial),feature={id:'one',date:'2026-10-14',subject:'feat: add history',body:'Changelog: 新增历史记录\nChangelog: 可回看旧局'};
 const next=collectNotes([feature],initial);assert.notEqual(base.version,next.version);assert.deepEqual(next.entries[0].items,['新增历史记录','可回看旧局']);
 assert.equal(collectNotes([{id:'docs',subject:'docs: readme',body:''}],initial).version,base.version);
 const fix=collectNotes([{id:'two',date:'2026-10-14',subject:'fix: 缓存签名错误',body:''},feature],initial);assert.notEqual(fix.version,next.version);assert.equal(fix.entries[0].items[0],'缓存签名错误');
});
test('unread changelog survives failed saves, isolates users, prompts new versions and checks updates on focus',async()=>{
 const values=new Map();let user='first',fail=false,remote={version:'one',entries:[{date:'2026-10-14',title:'更新',items:['内容']},{date:'2026-10-13',title:'旧更新',items:['历史内容']}]},focus;
 const node=()=>({children:[],append(...items){this.children.push(...items)},replaceChildren(){this.children=[]}});
 const dialog={open:false,showModal(){this.open=true},close(){this.open=false},addEventListener(type,handler){this[type]=handler}},button={disabled:false},notice={},open={},entries=node(),version={};
 const Cloud={boot:async()=>{},storage:async(key,value)=>{if(fail)throw Error('quota');const k=user+'|'+key;if(value!==undefined)values.set(k,value);return values.get(k)}};
 const document={hidden:false,createElement:node,addEventListener(){},getElementById:id=>({changelogDialog:dialog,changelogAcknowledge:button,changelogNotice:notice,changelogOpen:open,changelogEntries:entries,changelogVersion:version})[id]};
 const context=()=>({Cloud,document,QS_RELEASE_NOTES:remote,window:{addEventListener(type,handler){if(type==='focus')focus=handler}},setInterval(){},fetch:async()=>({ok:true,json:async()=>remote})});
 const run=async()=>{vm.runInNewContext(source,context());await tick()};
 await run();assert.equal(dialog.open,true);assert.equal(values.size,0);let prevented=false;dialog.cancel({preventDefault(){prevented=true}});assert.equal(prevented,true);
 assert.equal(entries.children.length,2);assert.equal(entries.children[1].children[0].textContent,'历史更新');assert.equal(entries.children[1].children.length,2);assert.notEqual(entries.children[1].open,true);
 fail=true;await button.onclick();assert.equal(dialog.open,true);assert.match(notice.textContent,/保存失败/);fail=false;await button.onclick();assert.equal(dialog.open,false);
 await run();assert.equal(dialog.open,false);open.onclick();assert.equal(dialog.open,true);await button.onclick();
 remote={...remote,version:'two'};focus();await tick();assert.equal(dialog.open,true);await button.onclick();focus();await tick();assert.equal(dialog.open,false);
 user='second';await run();assert.equal(dialog.open,true);assert.equal(values.size,2);
});
