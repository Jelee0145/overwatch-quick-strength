# 腾讯云独立网站

网站与 Bot 共用原有 `/api/v1/query`、`/api/v1/jobs/{id}` 和账户 API 密钥。网页登录、授权、额度、签名缓存、跨设备历史及 AI 仍使用同一套服务代码。Cloudflare 构建根目录保持 `/`。

## 运行与数据

- Node.js 24；进程由 `owqs.service` 管理，监听 `127.0.0.1:8788`，Nginx 提供公网 HTTPS。
- `/opt/owqs/releases/<版本>/` 保存白名单应用包，`/opt/owqs/current` 指向当前版本。更新时创建新版本目录，保留旧版本用于回滚。
- `/etc/owqs/config.json` 保存运行配置，权限 `root:owqs 0640`。禁止放进应用包、Git、静态目录或日志。
- `/var/lib/owqs/state.sqlite3` 保存账号、额度、API 密钥加密记录、任务、签名历史及持久化告警。SQLite 开启 WAL 和 FULL 同步；备份使用 SQLite backup API，不能只复制运行中的主文件而遗漏 WAL。
- 只运行一个网站进程；SQLite 事务队列、任务串行化和全站大神请求调度由该进程负责。不同用户最多并行执行四个后台对象，上游最多同时三个请求、启动间隔至少 500ms。
- `journalctl -u owqs` 查看服务状态；应用不打印账号、密钥、查询缓存或迁移正文。

整包 JSON 原子存储替代原 Durable Objects 的分片删除/写入过程。Cloudflare 保留原分片路径。查询内的玩家身份按上游 token 复用计算，不更改评分、缓存有效期或签名内容。

## 构建与验证

```sh
npm ci
npm run build
npm test
npm run check
node scripts/package-server.mjs
```

`dist/owqs-server.tar.gz` 只包含 `server/`、`src/`、构建后的 `public/`、初始化访问策略及最小 package.json，不含 `local/`、`.private/`、`.dev.vars`、Git 或研究数据。SHA-256 在相邻 `.sha256` 文件中。部署前核对校验值，在新 release 目录解压；不要覆盖数据库或配置。

`npm run server:start` 从 `OWQS_CONFIG` 和 `OWQS_DATA` 指定的目录启动；默认读取上述 Linux 路径。生产配置必须有 `PUBLIC_ORIGIN`、`PASSWORD_PEPPER`、`CACHE_SIGNING_KEY`、`API_KEY_ENCRYPTION_KEY`、`ADMIN_PASSWORD_HASH`；查询需要大神配置，AI 需要 `DEEPSEEK_KEY`。

## 公网 IP 与证书

`deploy/nginx-http.conf` 仅提供 ACME 校验与 HTTPS 跳转，`deploy/nginx-https.conf` 代理应用。Cookie 始终带 Secure。公网 IP 使用 Let's Encrypt shortlived 证书，必须启用 `owqs-cert-renew.timer` 每 12 小时检查并在续期后重载 Nginx。安全组需允许 TCP 80 和 443。不要把应用的 8788 端口暴露公网。

配置域名后，将 `PUBLIC_ORIGIN`、Nginx server_name、证书配置和 HTTP 跳转一起更新。原 IP 浏览器站点数据不会自动出现在新域名；云端账号历史保留。

## 迁移 Cloudflare 账号与历史

`scripts/migrate-to-server.mjs` 必须显式设置 `OWQS_SSH_HOST`、`OWQS_SSH_KEY` 和 `OWQS_PUBLIC_ORIGIN` 后单独运行，不能加入构建或普通发布流程。

它下载并校验当前线上 Worker 代码，临时安装 15 分钟自动失效、使用专用随机 Bearer 密钥的导出桥；导出期间暂时暂停旧站写请求和告警。账号、原有密码 pepper、签名密钥、API 加密密钥和已签名历史在内存中组装，经 HTTPS 与 SSH 标准输入送到目标。不会复制本地私有文件。导入器先验证历史签名及分片完整性，目标数据库必须为空，随后通过单个事务导入；相同快照可幂等重试，不同快照拒绝覆盖。

无论导入成功与否，脚本都会恢复原 Worker 代码、删除临时密钥并比对源码摘要与绑定名称。仅源码备份保存在 `dist/migration-code-backup/`，不包含运行密钥或迁移数据；若进程意外终止，运行 `node scripts/migrate-to-server.mjs --restore` 恢复。不要在桥仍启用时启动第二次迁移。

运行中任务不迁移，迁移完成后重新发起；浏览器本地缓存可在新站登录后同步，但尚未上传旧站的本地历史需先在旧站完成同步。迁移是一次快照，之后两个站点的新增账号与历史分别保存，不会持续互相同步。

Bot 在账户 API 面板获取已有密钥，Base URL 指向新站点。字段与计费见 [BOT-API.md](BOT-API.md)。API 使用 Bearer 密钥，网页保持同源与 CSRF 校验。
