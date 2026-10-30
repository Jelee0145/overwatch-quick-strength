#!/usr/bin/env node
// Explicit administrator command. It never discovers or reads a default config.
import { chmod, chown, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPushSender, generatePushKeys } from '../backend/server/web-push.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIELDS = ['WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY', 'WEB_PUSH_SUBJECT'];
const USAGE = `用法：
  node scripts/setup-event-push.mjs --config <绝对路径> [--subject mailto:地址 | https://地址]
  node scripts/setup-event-push.mjs

说明：
  不带参数只显示本用法，不读取任何配置。
  只有显式 --config 才读取管理员指定的 JSON 文件；不会自动读取 /etc/owqs/config.json。
  生产默认路径 /etc/owqs/config.json 仅作为示例，也可由 OWQS_CONFIG 指定其他位置。
  WEB_PUSH_PUBLIC_KEY、WEB_PUSH_PRIVATE_KEY、WEB_PUSH_SUBJECT 三项完整时保持密钥不轮换。
  缺少字段时生成新密钥，并要求有效的 --subject 或已有 SUBJECT。
  目标必须是已存在的普通文件；符号链接、目录和仓库（含 public/）内的路径会被拒绝。
  写入使用同目录 0600 临时文件和 rename 原子替换，保留其他 JSON 字段。
  不打印配置或任何密钥，只报告配置完成。首次启用或轮换密钥后需重启 owqs.service。`;

class SetupError extends Error {}

function usage() {
  console.log(USAGE);
}

function fail(message) {
  throw new SetupError(message);
}

function parseArgs(argv) {
  const options = { config: null, subject: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') return { help: true };
    if (argument === '--config') {
      if (options.config !== null) fail('--config 只能指定一次');
      if (index + 1 >= argv.length) fail('--config 需要一个绝对路径');
      options.config = argv[++index];
    } else if (argument.startsWith('--config=')) {
      if (options.config !== null) fail('--config 只能指定一次');
      options.config = argument.slice('--config='.length);
    } else if (argument === '--subject') {
      if (options.subject !== null || index + 1 >= argv.length)
        fail('--subject 需要一个 mailto: 或 https: 地址');
      options.subject = argv[++index];
    } else if (argument.startsWith('--subject=')) {
      if (options.subject !== null) fail('--subject 只能指定一次');
      options.subject = argument.slice('--subject='.length);
    } else {
      fail('存在未知参数');
    }
  }
  return options;
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}

function validatePush(publicKey, privateKey, subject, message) {
  try {
    // Reuse the runtime's VAPID validation without sending a notification.
    createPushSender({ publicKey, privateKey, subject });
  } catch {
    fail(message);
  }
}

async function atomicWrite(target, config, original) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomBytes(8).toString('hex')}.tmp`
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (process.platform !== 'win32') {
      if (
        typeof process.getuid === 'function' &&
        (original.uid !== process.getuid() || original.gid !== process.getgid())
      ) {
        // Keep the temporary file private while restoring the service-visible owner.
        try {
          await chown(temporary, original.uid, original.gid);
        } catch {
          throw new SetupError('无法保留配置文件的原有所有者，未写入');
        }
      }
      // Never broaden permissions to other users; the final file stays at most 0640.
      const mode = original.mode & 0o640 || 0o600;
      try {
        await chmod(temporary, mode);
      } catch {
        throw new SetupError('无法设置配置文件权限，未写入');
      }
    }
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof SetupError) throw error;
    throw new SetupError('配置写入失败，原文件未改动');
  }
}

async function configure(options) {
  if (!path.isAbsolute(options.config)) fail('--config 必须是绝对路径');
  const target = path.resolve(options.config);
  let original;
  try {
    original = await lstat(target);
  } catch {
    fail('目标配置必须是已存在的普通文件');
  }
  if (original.isSymbolicLink() || !original.isFile()) {
    fail('目标配置必须是普通文件，且不能是符号链接');
  }
  let resolved;
  try {
    resolved = await realpath(target);
  } catch {
    fail('无法解析目标配置路径');
  }
  const repository = await realpath(REPO_ROOT).catch(() => REPO_ROOT);
  if (isInside(resolved, repository)) fail('拒绝把推送凭证写入仓库或 public 目录');

  let raw;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    fail('无法读取目标配置');
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail('目标配置不是有效 JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    fail('目标配置必须是 JSON 对象');

  const complete = FIELDS.every((field) => hasValue(config[field]));
  let publicKey;
  let privateKey;
  let subject;
  if (complete) {
    publicKey = config.WEB_PUSH_PUBLIC_KEY;
    privateKey = config.WEB_PUSH_PRIVATE_KEY;
    subject = options.subject === null ? config.WEB_PUSH_SUBJECT : options.subject;
    validatePush(
      publicKey,
      privateKey,
      subject,
      '现有推送配置无效；未做修改。如需重新生成，请移除三项 WEB_PUSH_* 字段后重试'
    );
    if (options.subject === null || options.subject === config.WEB_PUSH_SUBJECT) {
      console.log('预约推送配置已完成。');
      return;
    }
  } else {
    const generated = generatePushKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    subject =
      options.subject === null
        ? hasValue(config.WEB_PUSH_SUBJECT)
          ? config.WEB_PUSH_SUBJECT
          : null
        : options.subject;
    if (!subject) fail('缺少 WEB_PUSH_SUBJECT，请通过 --subject mailto:... 或 https://... 指定');
    validatePush(
      publicKey,
      privateKey,
      subject,
      '推送 SUBJECT 无效，请使用 mailto:... 或 https://... 地址'
    );
  }

  await atomicWrite(
    target,
    {
      ...config,
      WEB_PUSH_PUBLIC_KEY: publicKey,
      WEB_PUSH_PRIVATE_KEY: privateKey,
      WEB_PUSH_SUBJECT: subject
    },
    original
  );
  console.log('预约推送配置已完成。');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : '参数无效');
    usage();
    process.exitCode = 1;
    return;
  }
  if (options.help || !options.config) {
    usage();
    return;
  }
  await configure(options);
}

main().catch((error) => {
  console.error(error instanceof SetupError ? error.message : '预约推送配置未完成。');
  process.exitCode = 1;
});
