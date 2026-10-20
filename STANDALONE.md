# 腾讯云独立网站

网站与 Bot 共用原有 `/api/v1/query`、`/api/v1/jobs/{id}` 和账户 API 密钥。网页登录、授权、额度、签名缓存、跨设备历史及 AI 仍使用同一套服务代码。Cloudflare 构建根目录保持 `/`。

## 运行与数据

- Node.js 24；进程由 `owqs.service` 管理，监听 `127.0.0.1:8788`，Nginx 提供公网 HTTPS。
- 赛事中心的 `EVENTS` 缓存使用同一 SQLite 文件内独立的 `events` 命名空间，不改账号或查询额度。赛程请求直接访问 Liquipedia，不占大神接口调度；`PUBLIC_ORIGIN` 默认用作上游 User-Agent 联系地址，也可通过 `EVENTS_CONTACT` 指定公开联系网址／邮箱。HTML 解析器已在构建时打包，不需在服务器安装 npm 依赖。
- 网站启动时检查本小时同步记录，必要时补同步，通过持久化告警每小时整点同步。进入赛事页自动请求刷新，也可手动刷新；服务器合并并发请求，至少间隔 30 秒，失败后至少退避 5 分钟并遵守 Retry-After。Bot 和网页通过共享接口按完整日期范围及赛事范围补查，默认仍为 OWCS。补查队列与分块结果也保存在 events 命名空间，重启／无人访问时由告警继续，使用同一上游间隔和退避。补查结果独立于近期快照，过去日期缓存 24 小时、其他缓存 1 小时，失败可保留 7 天旧结果；最多 8 个共享查询。旧数据最多保留 48 小时，失败时提示并保留当前内容。
- `/opt/owqs/releases/<版本>/` 保存白名单应用包，`/opt/owqs/current` 指向当前版本。更新时创建新版本目录，保留旧版本用于回滚。
- `/etc/owqs/config.json` 保存运行配置，权限 `root:owqs 0640`。禁止放进应用包、Git、静态目录或日志。
- `/var/lib/owqs/state.sqlite3` 保存账号、额度、API 密钥加密记录、任务、签名历史及持久化告警。SQLite 开启 WAL 和 FULL 同步；备份使用 SQLite backup API，不能只复制运行中的主文件而遗漏 WAL。
- 只运行一个网站进程；SQLite 事务队列、任务串行化和全站大神请求调度由该进程负责。不同用户最多并行执行四个后台对象，上游最多同时三个请求、启动间隔至少 500ms。
- `journalctl -u owqs` 查看服务状态；应用不打印账号、密钥、查询缓存或迁移正文。

整包 JSON 原子存储替代原 Durable Objects 的分片删除/写入过程。Cloudflare 保留原分片路径。查询内的玩家身份按上游 token 复用计算，不更改评分、缓存有效期或签名内容。

## 预约推送（Web Push）

**状态：2026-10-20 已发布至腾讯云 `/opt/owqs/releases/20261020-03d7dbc`。** 预约路由、官方直播入口和全站三秒悬浮提醒已上线；服务器已生成并配置 `WEB_PUSH_*`，原配置项保留。公网健康、未登录鉴权、脚本与版本更新日志已核验。真实设备的系统通知及关页送达尚未完成验收，仍受浏览器授权、系统设置和推送网络影响。

比赛中心的开赛提醒由网站进程直接发送，不经过 Cloudflare。`server/runtime.mjs` 只有在 `WEB_PUSH_PUBLIC_KEY`、`WEB_PUSH_PRIVATE_KEY`、`WEB_PUSH_SUBJECT` 三项非空时才创建推送发送器；缺少任一项时页面显示提醒服务未启用，订阅和预约接口返回 503。配置只在启动时读取，首次启用或修改后必须重启 `owqs.service`。运行环境为 Node.js 24。

### 配置工具

`scripts/setup-event-push.mjs` 是显式的管理员命令，不加入构建、启动或定时任务：

```sh
# 只显示用法，不读取任何配置
node scripts/setup-event-push.mjs

# 三字段已完整：只校验，保持密钥不轮换
node scripts/setup-event-push.mjs --config /etc/owqs/config.json

# 缺少字段或需要指定联系人：生成密钥并写入
node scripts/setup-event-push.mjs --config /etc/owqs/config.json --subject mailto:ops@example.com
node scripts/setup-event-push.mjs --config /etc/owqs/config.json --subject https://example.com/contact
```

- `--config` 必须是绝对路径，且指向已存在的普通文件。工具不会自动读取 `/etc/owqs/config.json`；文中该路径只是生产默认位置的说明。目标为目录、其他非普通文件或符号链接时拒绝处理。
- 三项 `WEB_PUSH_*` 已完整时沿用原密钥，不重新生成；可用 `--subject` 修正联系人。若现有密钥对或 SUBJECT 无效，工具报错且不写文件；需要重新生成时，先由管理员删除这三项再运行。
- 生成密钥复用 `server/web-push.mjs` 的 `generatePushKeys()`；SUBJECT 与运行时使用同一套 VAPID 校验，只接受 `mailto:...` 或 `https://...` 联系人地址。
- 写入使用目标同目录的临时文件，权限 `0600`，写完 `fsync` 后 `rename` 原子替换；保留原 JSON 的其他字段。Linux 上尽量保留原文件所有者和 `0640` 以内的权限，无法保留所有者或设置权限时放弃写入；非 Linux 环境不调整所有者。
- 工具拒绝把配置写到仓库内（包括 `public/`）。如管理员需要备份，应放在仓库和静态目录之外，使用 `0600` 权限并在完成后移除；工具本身不创建备份。
- 工具不打印配置内容或任何密钥，成功时只报告“预约推送配置已完成”。

### 使用边界

- 每台浏览器需单独授权一次系统通知；提醒会发送到该账号所有已启用通知的设备，单账号最多 10 台。只授权部分浏览器时，其余设备不会收到。
- 推送订阅绑定当前访问源的 origin。更换 `PUBLIC_ORIGIN`、改用新域名或通过另一 IP 访问后，必须在每台设备重新启用通知；旧 origin 的订阅不能沿用。浏览器要求 HTTPS 安全上下文。
- 只有 OWCS 场次可可靠跟踪和预约。重复对阵会被标记为无法确认，TBD／待定队名不支持预约；其他赛事不提供预约。
- 赛程来自公开数据源，存在分钟级延迟，不是秒级推送。后台以每 2 分钟轮换核对赛事来源，开赛时再核实；多赛事共享请求间隔、限流或失败退避可能延后核对，超过 3 分钟未更新的场次不会触发提醒；开赛后 5 分钟内才拿到的新结果仍可能提醒，更晚则跳过，不会回放长时间中断前的旧提醒。
- 轮换推送密钥会使已有订阅无法解密，需要每台设备重新启用通知。配置变更后应按实际改动范围验证，真实推送需在 HTTPS 站点与已授权浏览器上验收；上线需取得用户授权。

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

`deploy/nginx-http.conf` 仅提供 ACME 校验与 HTTPS 跳转，`deploy/nginx-https.conf` 通过 8443 代理应用，当前 `PUBLIC_ORIGIN` 为 `https://106.55.47.68:8443`。Cookie 始终带 Secure。公网 IP 使用 Let's Encrypt shortlived 证书，必须启用 `owqs-cert-renew.timer` 每 12 小时检查并在续期后重载 Nginx。安全组需允许 IPv4 TCP 80 和 8443（来源 `0.0.0.0/0`）；IPv6 的 `::/0` 不会放行 IPv4。不要把应用的 8788 端口暴露公网。

配置域名后，将 `PUBLIC_ORIGIN`、Nginx server_name、证书配置和 HTTP 跳转一起更新。原 IP 浏览器站点数据不会自动出现在新域名；云端账号历史保留。

非标准端口不替代内地网站正式对外服务所需的备案；域名准备好后再完善正式入口。

## 迁移 Cloudflare 账号与历史

`scripts/migrate-to-server.mjs` 必须显式设置 `OWQS_SSH_HOST`、`OWQS_SSH_KEY` 和 `OWQS_PUBLIC_ORIGIN` 后单独运行，不能加入构建或普通发布流程。

它下载并校验当前线上 Worker 代码，临时安装 15 分钟自动失效、使用专用随机 Bearer 密钥的导出桥；导出期间暂时暂停旧站写请求和告警。账号、原有密码 pepper、签名密钥、API 加密密钥和已签名历史在内存中组装，经 HTTPS 与 SSH 标准输入送到目标。不会复制本地私有文件。导入器先验证历史签名及分片完整性，目标数据库必须为空，随后通过单个事务导入；相同快照可幂等重试，不同快照拒绝覆盖。

无论导入成功与否，脚本都会恢复原 Worker 代码、删除临时密钥并比对源码摘要与绑定名称。仅源码备份保存在 `dist/migration-code-backup/`，不包含运行密钥或迁移数据；若进程意外终止，运行 `node scripts/migrate-to-server.mjs --restore` 恢复。不要在桥仍启用时启动第二次迁移。

运行中任务不迁移，迁移完成后重新发起；浏览器本地缓存可在新站登录后同步，但尚未上传旧站的本地历史需先在旧站完成同步。迁移是一次快照，之后两个站点的新增账号与历史分别保存，不会持续互相同步。

Bot 在账户 API 面板获取已有密钥，Base URL 指向新站点。字段与计费见 [BOT-API.md](BOT-API.md)。API 使用 Bearer 密钥，网页保持同源与 CSRF 校验。
