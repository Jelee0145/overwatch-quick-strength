import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.ico':'image/x-icon'};
export function staticAssets(directory){
 const root=path.resolve(directory);
 return {async fetch(request){
  let name;try{name=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Bad path',{status:400});}
  if(name.split('/').some(p=>p.startsWith('.')||p.startsWith('_'))||name.includes('\\')||name.includes('\0'))return new Response('Not found',{status:404});
  const filename=path.resolve(root,'.'+name);if(!filename.startsWith(root+path.sep))return new Response('Not found',{status:404});
  try{
   const resolved=await realpath(filename);if(!resolved.startsWith(root+path.sep))return new Response('Not found',{status:404});
   const info=await stat(resolved);if(!info.isFile())return new Response('Not found',{status:404});
   const headers={'Content-Type':types[path.extname(filename)]||'application/octet-stream','Cache-Control':/^\/(static|media)\//.test(name)?'public, max-age=31536000, immutable':'no-store'};
   return new Response(await readFile(resolved),{headers});
  }catch{return new Response('Not found',{status:404});}
 }};
}
