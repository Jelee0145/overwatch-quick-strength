// Manual diagnostic only. Browser sessions and credentials stay in ignored .private/.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, lstat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { upstream } from '../backend/src/adapters/dashen.mjs';

const root = path.resolve(import.meta.dirname, '..');
const privateRoot = path.join(root, '.private');
const fields = ['DASHEN_ROLE_ID', 'DASHEN_TOKEN', 'DASHEN_DTS', 'DASHEN_SERVER'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class UserError extends Error {}

export function normalizeCredential(value) {
  const v = value?.result || value;
  const credential = {
    DASHEN_ROLE_ID: String(v?.DASHEN_ROLE_ID || v?.roleId || ''),
    DASHEN_TOKEN: String(v?.DASHEN_TOKEN || v?.token || ''),
    DASHEN_DTS: String(v?.DASHEN_DTS || v?.dts || v?.day || ''),
    DASHEN_SERVER: String(v?.DASHEN_SERVER || v?.server || '')
  };
  if (
    !/^\d+$/.test(credential.DASHEN_ROLE_ID) ||
    fields.some((key) => !credential[key] || credential[key].length > 4096)
  )
    throw new UserError('凭证缺少必要字段，未保存。');
  return credential;
}

export async function privateDirectory(directory) {
  const relative = path.relative(privateRoot, path.resolve(directory));
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new UserError('凭证和浏览器目录必须位于仓库 .private 内。');
  let current = root;
  for (const part of ['.private', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw new UserError('无法创建私有目录。');
    });
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new UserError('私有目录不能是符号链接或普通文件。');
  }
  return current;
}

export async function saveCredential(directory, credential) {
  directory = await privateDirectory(directory);
  const filename = path.join(directory, `credential-${Date.now()}.json`);
  await writeFile(filename, JSON.stringify(normalizeCredential(credential)), {
    mode: 0o600,
    flag: 'wx'
  });
  return filename;
}

// stdout is consumed in memory. Never forward SSH stderr or raw provider responses.
function ssh(host, command, input = '') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(host)) throw new UserError('SSH 主机名不合法。');
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new UserError('SSH 操作超时。'));
    }, 90000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 64000) child.kill();
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new UserError('无法启动 SSH。'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new UserError('SSH 诊断未成功；未输出敏感错误内容。'));
      else {
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new UserError('SSH 返回格式异常。'));
        }
      }
    });
    child.stdin.end(input);
  });
}
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

// This function is self-contained so the exact same probe can run over SSH.
export async function probeCredential(call, credential, tag) {
  try {
    const account = await call(credential, '/searchBnetAccount', null, {
      name: tag,
      token: credential.DASHEN_TOKEN,
      roleId: credential.DASHEN_ROLE_ID,
      dts: credential.DASHEN_DTS,
      server: credential.DASHEN_SERVER
    });
    if (!account?.customerToken) return { state: 'empty', hasPlayer: false };
    if (account.name && account.name.toLowerCase() !== tag.toLowerCase())
      return { state: 'different-player', hasPlayer: false };
    await new Promise((resolve) => setTimeout(resolve, 750));
    const list = await call(credential, '/customer/queryMatchList', {
      token: account.customerToken,
      gameMode: 'leisure',
      page: 1,
      season: ''
    });
    const rows = Array.isArray(list) ? list : list?.matchList || list?.recentMatchList;
    return {
      state: 'ok',
      hasPlayer: true,
      listReadable: Array.isArray(rows),
      recentMatchCount: Array.isArray(rows) ? rows.length : null
    };
  } catch (error) {
    return { state: 'error', status: Number.isFinite(error.status) ? error.status : null };
  }
}

// Browser-side only. Matches the official site's supported SHA-1 signing fallback.
// The existing WASM signer returned 825 for this legacy report endpoint in live verification.
export async function requestReportCredential(metadata) {
  if (location.origin !== 'https://ds.163.com') return { state: 'wrong-origin' };
  try {
    const cookie = (key) =>
      decodeURIComponent(
        document.cookie
          .split(';')
          .map((v) => v.trim())
          .find((v) => v.startsWith(key + '='))
          ?.split('=')
          .slice(1)
          .join('=') || ''
      );
    const body = JSON.stringify({
      appKey: 'bn',
      roleId: metadata.roleId,
      server: metadata.server,
      source: 1,
      type: 'yearly'
    });
    const csrf = cookie('GL-XSRF-TOKEN');
    if (!csrf || !cookie('GOD_UUID')) return { state: 'login-required' };
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body + csrf));
    const sign = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const response = await fetch('https://inf.ds.163.com/v1/web/game/report/getReportToken', {
      method: 'POST',
      credentials: 'include',
      body,
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'GL-ClientType': '61',
        'GL-DeviceId':
          localStorage.getItem('ns-client-id') || localStorage.getItem('ds-website-uuid') || '',
        'GL-Uid': cookie('GOD_UUID'),
        'GL-X-XSRF-TOKEN': csrf,
        'GL-CheckSum': sign,
        'GL-Nonce': String(Date.now())
      }
    });
    const value = await response.json();
    if (!response.ok || !value.result?.token)
      return {
        state: 'not-ready',
        status: response.status,
        code: typeof value.code === 'number' ? value.code : undefined,
        reason: String(value.errmsg || value.errMsg || value.msg || value.message || '')
          .replace(/[^\u4e00-\u9fff，。！？：；（） ]/g, '')
          .slice(0, 100)
      };
    return {
      state: 'credential',
      value: {
        roleId: String(value.result.roleId || metadata.roleId),
        token: value.result.token,
        dts: String(value.result.day || metadata.dts),
        server: String(value.result.server || metadata.server)
      }
    };
  } catch {
    return { state: 'request-failed' };
  }
}

async function acquire(metadata, options) {
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require(process.env.OWQS_PLAYWRIGHT_MODULE || 'playwright'));
  } catch {
    throw new UserError('未找到 Playwright；请设置 OWQS_PLAYWRIGHT_MODULE 为其安装目录。');
  }
  const directory = await privateDirectory(path.join(privateRoot, 'dashen-refresh/browser'));
  const context = await chromium.launchPersistentContext(directory, {
    channel: options.browser,
    headless: false,
    viewport: { width: 1240, height: 850 },
    env: { ...process.env, DEBUG: '', PWDEBUG: '' }
  });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://ds.163.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pause(3000);
    console.log('浏览器已打开：请登录网易大神（可扫码），脚本会在登录后继续。');
    const deadline = Date.now() + options.waitSeconds * 1000;
    let lastAttempt = 0,
      attempts = 0,
      reported = 0;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new UserError('登录浏览器已关闭。');
      const ready = await page
        .evaluate(
          () =>
            location.hostname === 'ds.163.com' &&
            document.cookie.split(';').some((v) => v.trim().startsWith('GOD_UUID='))
        )
        .catch(() => false);
      if (ready && Date.now() - lastAttempt > 15000 && attempts < 8) {
        lastAttempt = Date.now();
        attempts++;
        const result = await page.evaluate(requestReportCredential, metadata);
        if (result.state === 'credential') return normalizeCredential(result.value);
        console.log(
          JSON.stringify({
            credentialRequest: result.state,
            status: result.status,
            code: typeof result.code === 'number' ? result.code : undefined,
            reason: result.reason
          })
        );
      }
      if (Date.now() - reported > 30000) {
        console.log('等待大神登录…');
        reported = Date.now();
      }
      await pause(1500);
    }
    throw new UserError('等待登录超时；可重新运行，私有浏览器保留登录状态。');
  } finally {
    await context.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(
      'node scripts/refresh-dashen-credentials.mjs --ssh-host tencent --tag "昵称#编号" [--browser msedge|chrome] [--wait-seconds 600] [--from-json .private/凭证.json]'
    );
    return;
  }
  const options = { browser: 'msedge', waitSeconds: 600 };
  for (let i = 0; i < args.length; i += 2) {
    const key = {
      '--ssh-host': 'host',
      '--tag': 'tag',
      '--browser': 'browser',
      '--wait-seconds': 'waitSeconds',
      '--from-json': 'fromJson'
    }[args[i]];
    if (!key || !args[i + 1]) throw new UserError('命令参数不正确；使用 --help 查看。');
    options[key] = args[i + 1];
  }
  options.waitSeconds = Number(options.waitSeconds);
  if (
    !options.host ||
    !/^.+#\d+$/.test(options.tag || '') ||
    options.tag.length > 80 ||
    !['msedge', 'chrome'].includes(options.browser) ||
    !Number.isFinite(options.waitSeconds) ||
    options.waitSeconds < 30 ||
    options.waitSeconds > 1800
  )
    throw new UserError('请指定 SSH 主机与完整战网 ID，等待时间为 30–1800 秒。');
  // Read only the metadata required by getReportToken; no old secret leaves the server.
  const metadata = await ssh(
    options.host,
    'python3 -',
    "import json\nc=json.load(open('/etc/owqs/config.json'))\n" +
      "print(json.dumps({'roleId':c['DASHEN_ROLE_ID'],'dts':c['DASHEN_DTS'],'server':c['DASHEN_SERVER']}))\n"
  );
  for (const key of ['roleId', 'dts', 'server']) metadata[key] = String(metadata[key] || '');
  if (!/^\d+$/.test(metadata.roleId) || !metadata.dts || !metadata.server)
    throw new UserError('线上凭证元数据不完整。');
  let credential;
  if (options.fromJson) {
    const file = path.resolve(options.fromJson);
    await privateDirectory(path.dirname(file));
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new UserError('凭证输入必须是私有目录中的普通文件。');
    credential = normalizeCredential(JSON.parse(await readFile(file, 'utf8')));
  } else credential = await acquire(metadata, options);
  const filename = await saveCredential(path.join(privateRoot, 'dashen-refresh'), credential);
  console.log('官方返回的凭证已保存到忽略目录；凭证值不会显示在终端。');
  const local = await probeCredential(upstream, credential, options.tag);
  console.log(JSON.stringify({ location: 'local', fresh: local }));
  const remoteCode = `import {readFile} from 'node:fs/promises';
import {upstream} from '/opt/owqs-work/src/adapters/dashen.mjs';
let input='';for await(const c of process.stdin)input+=c;
const {credential,tag}=JSON.parse(input);
const old=JSON.parse(await readFile('/etc/owqs/config.json','utf8'));
const probe=${probeCredential.toString()};
const previous=await probe(upstream,old,tag);
await new Promise(r=>setTimeout(r,1000));
const fresh=await probe(upstream,credential,tag);
console.log(JSON.stringify({location:'server',tokenChanged:old.DASHEN_TOKEN!==credential.DASHEN_TOKEN,credentialChanged:['DASHEN_ROLE_ID','DASHEN_TOKEN','DASHEN_DTS','DASHEN_SERVER'].some(k=>String(old[k])!==credential[k]),previous,fresh}));`;
  const remote = await ssh(
    options.host,
    'node --input-type=module -e ' + quote(remoteCode),
    JSON.stringify({ credential, tag: options.tag })
  );
  console.log(JSON.stringify(remote));
  const report = {
    at: new Date().toISOString(),
    local,
    remote,
    credentialFile: path.basename(filename),
    productionConfigChanged: false
  };
  await writeFile(
    path.join(path.dirname(filename), 'last-result.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 }
  );
  console.log('复测结束；未修改线上配置、未建立用户查询任务。');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      error instanceof UserError
        ? error.message
        : '凭证获取或复测未完成；未输出可能包含敏感信息的内部错误。'
    );
    process.exitCode = 1;
  });
}
