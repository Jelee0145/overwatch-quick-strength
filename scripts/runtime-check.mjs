import assert from 'node:assert/strict';
const base='http://127.0.0.1:18766';
async function post(path,body,headers={}){const r=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {r,v:await r.json()};}
for(const route of ['/login','/admin','/reset']){const r=await fetch(base+route,{redirect:'manual'});assert.equal(r.status,200,route+' must not redirect');}
const registered=await post('/api/auth/register',{email:'runtime-check@example.test',password:'runtime-player-123'});if(registered.r.status!==200)assert.equal(registered.r.status,400);
const player=await post('/api/auth/login',{email:'runtime-check@example.test',password:'runtime-player-123'});assert.equal(player.r.status,200);const userCookie=player.r.headers.get('set-cookie').split(';')[0];assert.ok(!player.v.token);
const admin=await post('/api/admin/login',{password:'local-admin-123'});assert.equal(admin.r.status,200);const adminCookie=admin.r.headers.get('set-cookie').split(';')[0];
const denied=await fetch(base+'/api/admin/users',{headers:{Cookie:userCookie}});assert.equal(denied.status,401);
const approved=await post('/api/admin/access',{id:player.v.user.id,status:'approved'},{Cookie:adminCookie,'X-CSRF-Token':admin.v.csrf});assert.equal(approved.r.status,200);
const home=await fetch(base+'/',{headers:{Cookie:userCookie}});assert.equal(home.status,200);const html=await home.text();assert.ok(!html.includes('大神查询凭据'));assert.ok(!html.includes('aiKeyDialog'));
const session=await (await fetch(base+'/api/auth/session',{headers:{Cookie:userCookie}})).json();assert.equal(session.user.aiDaily,100);assert.equal(session.user.status,'approved');
console.log('Runtime checks passed: routes, register/login, admin isolation, approval, secure cookies, 100 AI quota.');
