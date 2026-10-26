import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';

const base=path.resolve(import.meta.dirname,'../..');

async function info(relative){
 try{return await stat(path.join(base,relative));}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}

test('base UI and page templates have explicit owners outside source/',async()=>{
 for(const file of ['index.html','app.js','style.css','data.js'])assert.equal(await info(path.join('source',file)),null,`source/${file} must stay removed`);
 for(const file of ['app.js','style.css','data.js']){
  const target=await info(path.join('web/base',file));
  assert.ok(target?.isFile(),`web/base/${file} must exist`);
  assert.ok(target.size>0,`web/base/${file} must be non-empty`);
 }
 const page=await info('web/pages/strength.html');
 assert.ok(page?.isFile(),'web/pages/strength.html must exist');
 assert.ok(page.size>0,'web/pages/strength.html must be non-empty');
 for(const file of ['timeline.js','export.js','query.js','boot.js']){
  const module=await info(path.join('web/app',file));
  assert.ok(module?.isFile(),`web/app/${file} must exist`);
 }
 assert.ok((await info('source/chart.js'))?.isFile(),'source/chart.js must stay as the chart authority source');
});

test('web build reads the explicit app/page owners instead of source/',async()=>{
 const build=(await readFile(path.join(base,'scripts/build-web.mjs'),'utf8')).replace(/\s+/g,'');
 for(const file of ['app.js','style.css','data.js'])assert.ok(build.includes(`path.join(webBase,'${file}')`),`build-web must read ${file} from webBase`);
 assert.ok(build.includes("path.join(pages,'strength.html')"),'build-web must read the strength page from web/pages');
 for(const name of ['timeline.js','export.js','query.js','boot.js'])assert.ok(build.includes(`'${name}'`),`build-web must include web/app/${name}`);
 for(const stale of ["path.join(source,'app.js')","path.join(source,'style.css')","path.join(source,'data.js')","path.join(source,'index.html')"])assert.ok(!build.includes(stale),`build-web must not read ${stale}`);
});

test('build entrypoint delegates web assembly instead of carrying source surgery',async()=>{
 const build=await readFile(path.join(base,'scripts/build.mjs'),'utf8');
 assert.match(build,/buildBackend/);assert.match(build,/buildWeb/);
 assert.doesNotMatch(build,/replace\(|indexOf\(|slice\(/);
});
