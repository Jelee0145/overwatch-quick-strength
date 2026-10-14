import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const window={};vm.runInNewContext(await readFile(new URL('../web/draw-engine.js',import.meta.url),'utf8'),{window});
const engine=window.HeroDrawEngine,catalog=JSON.parse(await readFile(new URL('../web/draw/heroes.json',import.meta.url),'utf8')).heroes;
test('draw uses only the selected role and every pool member is reachable',()=>{
 for(const role of ['all','重装','输出','支援']){
  const pool=engine.pool(catalog,role);assert.ok(pool.length);
  for(let i=0;i<pool.length;i++){const hero=engine.pick(pool,()=>i);assert.equal(hero.id,pool[i].id);if(role!=='all')assert.equal(hero.role,role);}
 }
});
test('uint32 rejection prevents modulo bias; invalid random values and empty pools fail',()=>{
 let calls=0;assert.equal(engine.pick(catalog,()=>++calls===1?2**32-1:0).id,catalog[0].id);assert.equal(calls,2);
 assert.throws(()=>engine.pick([],()=>0),/为空/);for(const invalid of [-1,2**32,NaN,.5])assert.throws(()=>engine.pick(catalog,()=>invalid),/随机数/);
});
test('wheel has no duplicates in any nine-card window and preserves the selected hero',()=>{
 for(const role of ['all','重装','输出','支援']){
  const pool=engine.pool(catalog,role);
  for(const selected of pool){
   for(const [length,index] of [[9,4],[36,32]]){
    const sequence=engine.sequence(pool,length,index,selected,()=>0);
    assert.equal(sequence[index].id,selected.id);
    for(let i=0;i<=length-9;i++)assert.equal(new Set(sequence.slice(i,i+9).map(hero=>hero.id)).size,9);
   }
  }
 }
});
