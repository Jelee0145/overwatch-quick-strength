// Windowed history requests differ only by window start, so the exact response bytes are
// worth keeping: a hit skips the archive read, the signature checks, the scoring pass and
// JSON serialisation. Entries are validated by the archive revision, never by age.
export function createResponseCache({bytes=48*1024*1024,entries=32}={}){
 const store=new Map();let used=0;
 return {
  get(key){
   const hit=store.get(key);if(!hit)return null;
   store.delete(key);store.set(key,hit);
   return hit.body;
  },
  set(key,body){
   const old=store.get(key);
   if(old){used-=old.size;store.delete(key);}
   const size=new TextEncoder().encode(body).length;
   if(size>bytes)return body;
   store.set(key,{body,size});used+=size;
   for(const [name,value] of store){
    if(used<=bytes&&store.size<=entries)break;
    store.delete(name);used-=value.size;
   }
   return body;
  },
  clear(){store.clear();used=0;},
  stats(){return {entries:store.size,bytes:used};}
 };
}
