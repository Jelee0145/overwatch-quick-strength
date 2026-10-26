'use strict';
const el = (id) => document.getElementById(id);
let csrf = '',
  users = [],
  busy = false;
function message(text) {
  el('adminMessage').textContent = text;
}
const request = OWQS_HTTP.create({
  csrf: () => csrf,
  unauthorized: () => {
    el('panel').hidden = true;
    el('login').hidden = false;
  }
});
const call = (path, body) => request('/api/v1/admin/' + path, body);
const button = (label, handler) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.onclick = async () => {
    if (busy) return;
    busy = true;
    b.disabled = true;
    try {
      await handler();
      await load();
      message('操作已完成');
    } catch (e) {
      message(e.message);
    } finally {
      busy = false;
      b.disabled = false;
    }
  };
  return b;
};
function row(u, reset = false) {
  const box = document.createElement('div');
  box.className = 'admin-row';
  const info = document.createElement('div'),
    strong = document.createElement('strong'),
    small = document.createElement('small');
  strong.textContent = u.email;
  small.textContent =
    { pending: '等待批准', approved: '已授权', rejected: '已拒绝', revoked: '已撤销' }[u.status] +
    ' · ' +
    new Date(reset ? u.resetRequestedAt : u.createdAt).toLocaleString('zh-CN');
  info.append(strong, small);
  box.append(info);
  const actions = document.createElement('div');
  if (reset) {
    actions.append(
      button('核验后生成重置链接', async () => {
        const r = await call('reset', { id: u.id, action: 'issue' });
        el('resetLink').value = location.origin + '/reset#code=' + r.code;
        el('resetDialog').showModal();
      }),
      button('关闭申请', () => call('reset', { id: u.id, action: 'close' }))
    );
  } else {
    if (u.status !== 'approved')
      actions.append(
        button(u.status === 'pending' ? '批准' : '恢复授权', () =>
          call('access', { id: u.id, status: 'approved' })
        )
      );
    if (u.status === 'pending')
      actions.append(button('拒绝', () => call('access', { id: u.id, status: 'rejected' })));
    if (u.status === 'approved')
      actions.append(button('撤销授权', () => call('access', { id: u.id, status: 'revoked' })));
    const query = document.createElement('input'),
      ai = document.createElement('input');
    for (const [input, value, label] of [
      [query, u.queryDaily, '每日查询额度'],
      [ai, u.aiDaily, '每日 AI 额度']
    ]) {
      input.type = 'number';
      input.min = 0;
      input.max = 1000;
      input.value = value;
      input.setAttribute('aria-label', label);
    }
    actions.append(
      document.createTextNode('查询 '),
      query,
      document.createTextNode(' AI '),
      ai,
      button('保存额度', () =>
        call('quota', { id: u.id, queryDaily: Number(query.value), aiDaily: Number(ai.value) })
      )
    );
  }
  box.append(actions);
  return box;
}
function paint() {
  const filtered = users.filter((u) => u.email.includes(el('search').value.trim().toLowerCase()));
  for (const [id, items, reset] of [
    ['pending', filtered.filter((u) => u.status === 'pending'), false],
    ['resetUsers', filtered.filter((u) => u.resetRequestedAt), true],
    ['members', filtered.filter((u) => u.status !== 'pending'), false]
  ]) {
    el(id).replaceChildren(...items.map((u) => row(u, reset)));
    if (!items.length) el(id).textContent = '暂无玩家';
  }
  el('pendingTitle').textContent =
    '等待批准 · ' + users.filter((u) => u.status === 'pending').length;
  el('resetTitle').textContent = '密码重置申请 · ' + users.filter((u) => u.resetRequestedAt).length;
}
async function load() {
  users = (await call('users')).users;
  paint();
}
async function boot() {
  try {
    csrf = (await call('session')).csrf;
    el('login').hidden = true;
    el('panel').hidden = false;
    await load();
  } catch {}
}
el('adminLogin').onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  const password = el('adminPassword').value;
  el('adminPassword').value = '';
  try {
    csrf = (await call('login', { password })).csrf;
    await boot();
    message('');
  } catch (e) {
    message(e.message);
  } finally {
    busy = false;
  }
};
el('reload').onclick = () => load().catch((e) => message(e.message));
el('search').oninput = paint;
el('adminLogout').onclick = async () => {
  try {
    await call('logout', {});
    location.reload();
  } catch (e) {
    message(e.message);
  }
};
el('closeDialog').onclick = () => {
  el('resetLink').value = '';
  el('resetDialog').close();
};
el('resetDialog').addEventListener('close', () => (el('resetLink').value = ''));
el('copyLink').onclick = () =>
  navigator.clipboard.writeText(el('resetLink').value).catch(() => message('请手动复制链接'));
boot();
