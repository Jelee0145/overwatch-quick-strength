// Run in the Console of the authenticated https://ds.163.com page.
(async () => {
  const roleId = 'YOUR_ROLE_ID';
  if (location.hostname !== 'ds.163.com') throw Error('请在大神官网运行');
  if (!window.sig?.default) throw Error('请登录、刷新大神页面并等待签名模块加载');
  const body = JSON.stringify({appKey:'bn',roleId,server:'1',source:1,type:'yearly'});
  const mod = await window.sig.default();
  const sign = JSON.parse(mod.gen_sign(body));
  const cookie = key => document.cookie.split('; ').find(x=>x.startsWith(key+'='))?.split('=').slice(1).join('=') || '';
  const response = await fetch('https://inf.ds.163.com/v1/web/game/report/getReportToken', {
    method:'POST',credentials:'include',body,
    headers:{'Content-Type':'application/json;charset=UTF-8','GL-ClientType':'61',
      'GL-DeviceId':localStorage.getItem('ns-client-id')||localStorage.getItem('ds-website-uuid')||'',
      'GL-Uid':cookie('GOD_UUID'),'GL-X-XSRF-TOKEN':cookie('GL-XSRF-TOKEN'),
      'GL-CheckSum':sign.sign,'GL-Nonce':String(sign.timestamp)}
  });
  const result=await response.json();
  if (!response.ok || !result.result?.token) throw Error('未取得查询 Token，请确认登录和战网绑定；返回码 '+result.code);
  const value=JSON.stringify({roleId:String(result.result.roleId||roleId),token:result.result.token,dts:String(result.result.day||'2026'),server:String(result.result.server||'1')});
  if(typeof copy==='function'){copy(value);console.log('查询凭证 JSON 已复制，请粘贴到本机工具。');}
  else console.log('请复制下面的 JSON 到本机工具（包含凭证，请勿分享）：\n'+value);
})();
