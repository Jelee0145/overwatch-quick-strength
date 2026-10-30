'use strict';
(() => {
  const el = (id) => document.getElementById(id);
  const dialog = el('apiKeyDialog');
  if (!dialog || !window.Cloud) return;
  const status = el('apiKeyStatus'),
    value = el('apiKeyValue'),
    reveal = el('apiKeyReveal'),
    copy = el('apiKeyCopy'),
    regenerate = el('apiKeyRegenerate');
  let meta = { exists: false },
    key = '';
  const date = (stamp) => {
    const value = new Date(stamp);
    return Number.isFinite(value.getTime())
      ? value.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '—';
  };
  const reset = () => {
    key = '';
    value.value = '';
    value.type = 'password';
    reveal.textContent = '查看';
  };
  function paint() {
    status.textContent = meta.exists ? '已创建 · ' + date(meta.createdAt) : '尚未创建 API 密钥';
    regenerate.textContent = meta.exists ? '重新生成密钥' : '生成密钥';
    if (!meta.exists) reset();
  }
  const fail = (error) => {
    status.textContent = error?.message || '密钥操作失败';
  };
  const apply = (next) => {
    meta = { exists: true, createdAt: next.createdAt };
    paint();
  };
  async function open() {
    reset();
    status.textContent = '正在读取密钥状态…';
    try {
      const session = await Cloud.api('/api/auth/session');
      meta = session.user.apiKey || { exists: false };
      paint();
    } catch (e) {
      fail(e);
    }
    if (!dialog.open) dialog.showModal();
  }
  el('apiKeyOpen').onclick = open;
  reveal.onclick = async () => {
    if (key) {
      reset();
      status.textContent = '密钥已隐藏。';
      return;
    }
    try {
      const next = await Cloud.api('/api/auth/api-key', { action: 'reveal' });
      key = next.key;
      value.value = key;
      value.type = 'text';
      reveal.textContent = '隐藏';
      apply(next);
      status.textContent = '密钥已显示，请勿分享给他人。';
    } catch (e) {
      fail(e);
    }
  };
  copy.onclick = async () => {
    try {
      if (!key) {
        const next = await Cloud.api('/api/auth/api-key', { action: 'reveal' });
        key = next.key;
        value.value = key;
        apply(next);
      }
    } catch (e) {
      fail(e);
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      status.textContent = '密钥已复制。';
    } catch (e) {
      value.type = 'text';
      value.focus();
      value.select();
      status.textContent = '自动复制失败，请手动复制已选中的密钥。';
    }
  };
  regenerate.onclick = async () => {
    if (!confirm('重新生成后旧密钥立即失效，确定继续？')) return;
    regenerate.disabled = true;
    try {
      const next = await Cloud.api('/api/auth/api-key', { action: 'regenerate' });
      key = next.key;
      value.value = key;
      value.type = 'text';
      reveal.textContent = '隐藏';
      apply(next);
      status.textContent = '新密钥已生成，旧密钥已立即失效。';
    } catch (e) {
      fail(e);
    } finally {
      regenerate.disabled = false;
    }
  };
  el('apiKeyClose').onclick = () => {
    reset();
    dialog.close();
  };
  dialog.addEventListener('close', reset);
})();
