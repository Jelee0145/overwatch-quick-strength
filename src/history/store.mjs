import {Fault,digest,verifySnapshot} from '../security.mjs';

// Read a stable, authenticated archive. Do not concatenate pages from different revisions.
export async function readArchive(call,user,env,tag,expectedRevision){
 if(typeof tag!=='string'||!tag.trim()||tag.length>150)throw new Fault('历史账号无效');tag=tag.normalize('NFC').trim();
 for(let attempt=0;attempt<2;attempt++){
  const batches={};let cursor=0,revision=null,changed=false,pages=0;
  do{
   const page=await call('/history',{action:'pull',tag,cursor});if(revision!==null&&revision!==page.revision){changed=true;break;}revision=page.revision;
   for(const envelope of page.envelopes){await verifySnapshot(envelope,user,env,tag);batches[await digest(JSON.stringify(envelope))]=envelope;}
   const next=page.nextCursor;if(next!==null&&(!Number.isSafeInteger(next)||next<=cursor))throw new Fault('历史分页状态无效',503);cursor=next;
   if(++pages>100)throw new Fault('历史分页超过限制',503);
  }while(cursor!==null);
  if(changed)continue;
  if(expectedRevision&&expectedRevision!==revision)throw new Fault('历史已更新，请刷新后重试',409);
  return {tag,revision,scope:{server:env.DASHEN_SERVER,dts:env.DASHEN_DTS},batches};
 }
 throw new Fault('历史正在更新，请稍后重试',409);
}
