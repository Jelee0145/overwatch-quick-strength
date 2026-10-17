// Share one upstream request budget across every user on this server.
export function pacedFetch(fetcher=fetch,{intervalMs=500,concurrency=3}={}){
 let launches=Promise.resolve(),next=0,active=0;const waiting=[];
 const release=()=>{active--;waiting.shift()?.();};
 return async(url,init)=>{
  const start=launches.then(async()=>{
   if(active>=concurrency)await new Promise(resolve=>waiting.push(resolve));
   const pause=Math.max(0,next-Date.now());if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
   init?.signal?.throwIfAborted();next=Date.now()+intervalMs;active++;
  });launches=start.catch(()=>{});await start;
  try{return await fetcher(url,init);}finally{release();}
 };
}
