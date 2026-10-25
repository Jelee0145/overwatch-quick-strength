import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {gzip,brotliCompress,constants} from 'node:zlib';

const encoders={gzip:promisify(gzip),br:body=>promisify(brotliCompress)(body,{params:{[constants.BROTLI_PARAM_QUALITY]:4}})};
export function negotiateEncoding(header=''){
 const values=new Map(header.toLowerCase().split(',').filter(Boolean).map(item=>{
  const [name,...params]=item.trim().split(';'),q=params.find(p=>p.trim().startsWith('q='));
  const value=q?Number(q.trim().slice(2)):1;
  return [name.trim(),Number.isFinite(value)&&value>=0&&value<=1?value:0];
 }));
 const quality=name=>values.get(name)??(name==='identity'?(values.get('*')===0?0:1):values.get('*')??0);
 const compressed=['br','gzip'].filter(name=>quality(name)>0).sort((a,b)=>quality(b)-quality(a));
 if(compressed.length&&quality(compressed[0])>=(values.get('identity')??0))return compressed[0];
 return quality('identity')>0?'identity':null;
}

export function createAnalysisEncoder({bytes=12*1024*1024,entries=32}={}){
 const cache=new Map(),pending=new Map();let used=0;
 return {
  async encode(body,encoding){
   if(encoding==='identity')return body;
   const key=encoding+':'+createHash('sha256').update(body).digest('hex'),hit=cache.get(key);
   if(hit){cache.delete(key);cache.set(key,hit);return hit;}
   if(pending.has(key))return pending.get(key);
   const work=encoders[encoding](body).then(value=>{
    if(value.length<=bytes){cache.set(key,value);used+=value.length;for(const [id,old] of cache){if(used<=bytes&&cache.size<=entries)break;cache.delete(id);used-=old.length;}}
    return value;
   }).finally(()=>pending.delete(key));
   pending.set(key,work);return work;
  },
  stats:()=>({entries:cache.size,bytes:used})
 };
}
