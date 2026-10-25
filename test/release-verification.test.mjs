import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {verifyRevision} from '../scripts/verify-release.mjs';

test('release verification builds before tests outside the live checkout and cleans up on success/failure',()=>{
 for(const fail of [false,true]){
  const calls=[],root=path.resolve('.'),revision='a'.repeat(40);
  const run=(command,args,options)=>{calls.push({command,args,options});if(fail&&args[0]==='test')throw Error('test failed');};
  if(fail)assert.throws(()=>verifyRevision({root,revision,run}),/test failed/);else verifyRevision({root,revision,run});
  assert.deepEqual(calls.map(c=>[c.command,...c.args.slice(0,2)]),[['git','worktree','add'],['npm','ci','--no-audit'],['npm','run','build'],['npm','test'],['git','worktree','remove']]);
  const checkout=calls[0].args[3];assert.notEqual(checkout,root);
  for(const call of calls.filter(c=>c.command==='npm'))assert.equal(call.options.cwd,checkout);
  assert.equal(existsSync(path.dirname(checkout)),false);
 }
 assert.throws(()=>verifyRevision({root:'.',revision:'main',run:()=>assert.fail('should not run')}),/Invalid release revision/);
});
