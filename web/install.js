(() => {
  'use strict';
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone)
    return;
  let installEvent = null,
    timer = null;
  const key = 'owqs:install-dismissed';
  const ios =
    /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);
  const css = `#owqs-install{position:fixed;z-index:10000;left:50%;bottom:max(20px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(440px,calc(100vw - 28px));display:flex;align-items:center;gap:14px;padding:15px 16px;background:#fff;border:1px solid #ead8c6;border-radius:12px;box-shadow:0 12px 40px #242a3440;color:#343941;font:14px/1.5 "Microsoft YaHei","PingFang SC",sans-serif}#owqs-install[hidden]{display:none}#owqs-install .owqs-install-copy{flex:1;min-width:0}#owqs-install strong{display:block;font-size:14px}#owqs-install small{display:block;margin-top:3px;color:#777e88;font-size:12px}#owqs-install button{border:1px solid #e3e5e8;border-radius:6px;background:white;color:#343941;padding:8px 11px;font:inherit;white-space:nowrap;cursor:pointer}#owqs-install button[data-install]{border-color:#f58220;background:#f58220;color:white;font-weight:600}#owqs-install button:focus-visible{outline:2px solid #f58220;outline-offset:3px}@media(max-width:420px){#owqs-install{gap:8px;padding:12px}#owqs-install small{font-size:11px}#owqs-install button{padding:8px}}`;
  function dismissed() {
    try {
      return Date.now() - Number(localStorage.getItem(key)) < 30 * 86400000;
    } catch {
      return false;
    }
  }
  function close() {
    const el = document.getElementById('owqs-install');
    if (el) el.hidden = true;
    try {
      localStorage.setItem(key, String(Date.now()));
    } catch {}
  }
  function render() {
    if ((!installEvent && !ios) || dismissed()) return;
    if (!document.getElementById('owqs-install-style')) {
      const style = document.createElement('style');
      style.id = 'owqs-install-style';
      style.textContent = css;
      document.head.append(style);
    }
    let panel = document.getElementById('owqs-install');
    if (!panel) {
      panel = document.createElement('aside');
      panel.id = 'owqs-install';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', '安装狸狸天眼查');
      panel.innerHTML =
        '<div class="owqs-install-copy"><strong>把狸狸天眼查安装到设备</strong><small></small></div><button type="button" data-install>安装</button><button type="button" data-close aria-label="稍后">稍后</button>';
      document.body.append(panel);
      panel.querySelector('[data-close]').addEventListener('click', close);
      panel.querySelector('[data-install]').addEventListener('click', async () => {
        if (installEvent) {
          const event = installEvent;
          installEvent = null;
          panel.hidden = true;
          try {
            await event.prompt();
            await event.userChoice;
          } catch {}
          if (!window.matchMedia('(display-mode: standalone)').matches) close();
        } else {
          panel.querySelector('small').textContent =
            '在 Safari 中点“分享”，然后选择“添加到主屏幕”。';
        }
      });
    }
    panel.querySelector('small').textContent = ios
      ? '在 Safari 中点“分享”，然后选择“添加到主屏幕”。'
      : '安装后可从桌面或应用列表直接打开。';
    panel.querySelector('[data-install]').hidden = ios;
    panel.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installEvent = event;
    clearTimeout(timer);
    timer = setTimeout(render, 1200);
  });
  window.addEventListener('appinstalled', () => {
    clearTimeout(timer);
    document.getElementById('owqs-install')?.remove();
    try {
      localStorage.setItem(key, String(Date.now()));
    } catch {}
  });
  if (ios && !dismissed()) timer = setTimeout(render, 1800);
})();
