import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {CATALOG,planSync,applyPlan,resolveCheckExitCode,parseArgs} from '../../scripts/sync-local.mjs';

const SCRIPT=path.resolve(import.meta.dirname,'../../scripts/sync-local.mjs');

async function put(dir,rel,content){
  const target=path.join(dir,...rel.split('/'));
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,content);
  return target;
}

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'owqs-sync-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const localDir=path.join(root,'local');
  const sourceDir=path.join(root,'source');
  await mkdir(localDir,{recursive:true});
  await mkdir(sourceDir,{recursive:true});
  return {root,localDir,sourceDir};
}

async function seedIdentical(localDir,sourceDir){
  for(const file of CATALOG){
    const content=`same:${file}`;
    await put(localDir,file,content);
    await put(sourceDir,file,content);
  }
}

function makeIo(dirty=[]){
  const dirtySet=new Set(dirty.map(entry=>path.resolve(entry)));
  const wrote=[];
  const io={
    readFile:target=>readFile(target,'utf8'),
    async writeFile(target,content){wrote.push(target);await writeFile(target,content);},
    isDirty:target=>dirtySet.has(path.resolve(target)),
  };
  return {io,wrote};
}

const statusOf=(plan,file)=>plan.entries.find(entry=>entry.file===file)?.status;

test('default run is a dry-run and writes nothing',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await seedIdentical(localDir,sourceDir);
  await put(localDir,'core.js','LOCAL-CORE');
  await put(sourceDir,'core.js','CLOUD-CORE');
  const {io,wrote}=makeIo();
  const plan=await planSync({localDir,sourceDir,io});
  assert.equal(wrote.length,0);
  assert.equal(plan.writes.length,0);
  assert.equal(statusOf(plan,'core.js'),'changed');
  assert.equal(statusOf(plan,'rating-rules.js'),'same');
  assert.deepEqual(plan.differences,['core.js']);
  assert.equal(resolveCheckExitCode(plan),1);
  assert.equal(await readFile(path.join(sourceDir,'core.js'),'utf8'),'CLOUD-CORE');
});

test('identical trees exit 0',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await seedIdentical(localDir,sourceDir);
  const {io,wrote}=makeIo();
  const plan=await planSync({localDir,sourceDir,io});
  assert.deepEqual(plan.differences,[]);
  assert.deepEqual(plan.blockers,[]);
  assert.equal(resolveCheckExitCode(plan),0);
  assert.equal(wrote.length,0);
});

test('CRLF/LF differences are not treated as changes',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await put(localDir,'core.js','a\r\nb\r\n');
  await put(sourceDir,'core.js','a\nb\n');
  const {io}=makeIo();
  const plan=await planSync({only:'core.js',localDir,sourceDir,io});
  assert.equal(statusOf(plan,'core.js'),'same');
});

test('CATALOG excludes web and chart files',()=>{
  assert.deepEqual([...CATALOG],[
    'core.js',
    'benchmarks.js',
    'rating-rules.js',
    'resource-rating.js',
    'performance.js',
    'data/heroes.json',
    'data/maps.json',
    'ai_review.py',
    'AI锐评-游戏常识.md',
  ]);
});

test('--apply without --only refuses to write',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await seedIdentical(localDir,sourceDir);
  await put(localDir,'core.js','NEW-CORE');
  await put(sourceDir,'core.js','OLD-CORE');
  const {io,wrote}=makeIo();
  const plan=await planSync({apply:true,localDir,sourceDir,io});
  assert.equal(plan.blocked,true);
  assert.equal(plan.writes.length,0);
  assert.equal(wrote.length,0);
  assert.ok(plan.blockers.some(message=>message.includes('--only')));
  assert.equal(await readFile(path.join(sourceDir,'core.js'),'utf8'),'OLD-CORE');
});

test('--apply --only writes only the selected file',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await put(localDir,'core.js','NEW-CORE');
  await put(sourceDir,'core.js','OLD-CORE');
  await put(localDir,'benchmarks.js','NEW-BENCH');
  await put(sourceDir,'benchmarks.js','OLD-BENCH');
  const {io,wrote}=makeIo();
  const plan=await planSync({only:'core.js',apply:true,localDir,sourceDir,io});
  assert.deepEqual(plan.writes.map(item=>item.file),['core.js']);
  const {written,errors}=await applyPlan(plan,io);
  assert.deepEqual(errors,[]);
  assert.deepEqual(written,['core.js']);
  assert.deepEqual(wrote,[path.join(sourceDir,'core.js')]);
  assert.equal(await readFile(path.join(sourceDir,'core.js'),'utf8'),'NEW-CORE');
  assert.equal(await readFile(path.join(sourceDir,'benchmarks.js'),'utf8'),'OLD-BENCH');
});

test('uncommitted source changes abort with zero writes',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await put(localDir,'core.js','NEW-CORE');
  await put(sourceDir,'core.js','OLD-CORE');
  const {io,wrote}=makeIo([path.join(sourceDir,'core.js')]);
  const plan=await planSync({only:'core.js',apply:true,localDir,sourceDir,io});
  assert.equal(plan.blocked,true);
  assert.equal(statusOf(plan,'core.js'),'dirty');
  assert.equal(plan.writes.length,0);
  assert.equal(wrote.length,0);
  assert.ok(plan.blockers.some(message=>message.includes('uncommitted changes')));
  assert.equal(await readFile(path.join(sourceDir,'core.js'),'utf8'),'OLD-CORE');
});

test('missing local file aborts with zero writes',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  await put(sourceDir,'core.js','OLD-CORE');
  const {io,wrote}=makeIo();
  const plan=await planSync({only:'core.js',apply:true,localDir,sourceDir,io});
  assert.equal(plan.blocked,true);
  assert.equal(statusOf(plan,'core.js'),'missing');
  assert.equal(plan.writes.length,0);
  assert.equal(wrote.length,0);
  assert.ok(plan.blockers.some(message=>message.includes('local file missing')));
  assert.equal(await readFile(path.join(sourceDir,'core.js'),'utf8'),'OLD-CORE');
});

test('unknown or empty --only targets are rejected',async t=>{
  const {localDir,sourceDir}=await fixture(t);
  const {io,wrote}=makeIo();
  const plan=await planSync({only:'nope.js',apply:true,localDir,sourceDir,io});
  assert.equal(plan.blocked,true);
  assert.equal(plan.writes.length,0);
  assert.equal(wrote.length,0);
  assert.ok(plan.blockers.some(message=>message.includes('unknown --only target')));
  for(const argv of [['--only='],['--only','']])assert.throws(()=>parseArgs(argv),/exactly one file/);
});

test('--help prints usage',()=>{
  const out=execFileSync(process.execPath,[SCRIPT,'--help'],{encoding:'utf8'});
  assert.match(out,/Usage: node scripts\/sync-local\.mjs/);
});
