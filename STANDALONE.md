# 腾讯云独立网站

网站与 Bot 共用原有 `/api/v1/query`、`/api/v1/jobs/{id}` 和账户 API 密钥。网页登录、授权、额度、签名缓存、跨设备历史及 AI 仍使用同一套服务代码。Cloudflare 构建根目录保持 `/`。

## 独立前后端

后端 `npm run server:build` 只生成 Node 业务与出图资源包，不包含完整网页；网页由 `npm run web:package` 生成独立包。Node 默认仅提供 API，组合开发预览设 `OWQS_SERVE_WEB=1`。当前线上由 Nginx 直接提供 `/opt/owqs-work/public`，API 转发回环端口；受保护页面通过只读会话检查保持登录跳转。操作与契约见 [统一后端说明](docs/unified-backend.md)。

## 单目录运行（2026-10-25 起）

仓库目录 `/opt/owqs-work` 就是线上应用，不再保留版本副本：

- `owqs.service` 的 `WorkingDirectory=/opt/owqs-work`，直接运行 `server/main.mjs`，出图资源读 `dist/backend-assets`。
- Nginx 网页根目录为 `/opt/owqs-work/public`；`.git`、`.private`、`.dev.vars` 不在网页目录内，且 Nginx 拒绝点开头的路径。
- 发布：确认工作区干净后运行 `node scripts/deploy-local.mjs`。它执行 `backend:build`、`web:build`，重启服务，核对线上健康版本与登录页字节一致，并打 `deploy/<日期>` 标签。
- 回滚：`git checkout deploy/<日期>` 后重跑同一命令；数据库不回滚，兼容迁移仍是独立前提。
- 历史批次存储 v2 启用后，回到仍使用整包 `batches` 的旧版本前，须先停止服务并用当前代码的 `scripts/history-storage-rollback.mjs` 校验、恢复旧格式，再 checkout。具体顺序及 WAL 备份边界见 [历史性能验收](docs/history-performance.md#存储迁移与回退)。仅切换代码不能恢复旧读路径。
- 服务用户 `owqs` 与 Nginx 只需读取权限；仓库其余文件保持 `root` 所有。数据库、配置仍在 `/var/lib/owqs` 与 `/etc/owqs`。
- 旧 `/opt/owqs/releases`、`web-releases`、`current`、`web-current` 及切换记录已于同日删除。`deploy/split-release.mjs` 保留为历史工具，不再用于本站发布。

### 推送自动发布

推送到 `main` 后由服务器侧轮询发布，不开放入站 SSH，也不需要仓库 Secret：

- `.github/workflows/deploy.yml` 在推送和手动触发时构建并运行完整测试，作为可见的构建记录。
- `owqs-autodeploy.timer` 每 2 分钟运行 `scripts/auto-deploy.mjs`：用服务器现有只读部署密钥取回 `main`，无新提交即退出。
- 有新提交时先在临时 detached worktree 执行 `npm ci`、`npm run build`、`npm test`，不覆盖正在服务的网页产物；验证结束清理临时目录。全部通过后才快进合并线上仓库。测试不通过就不合并、不发布，并记录该提交避免反复重试。临时目录仅用于验证，不是部署版本副本。
- 测试通过后调用 `scripts/deploy-local.mjs`：构建、重启、校验版本与静态资源、打 `deploy/<日期-时分>` 标签。
- 日志：`/var/log/owqs-auto-deploy.log`（轮询与测试）、`/var/log/owqs-ci-deploy.log`（已停用的旧 CI 入口）。
- 工作区有已跟踪文件改动时自动发布直接跳过，避免覆盖未提交修改。

数据库、配置、密钥和公网 origin 不因拆分变更。更新 `deploy/owqs.service` 的后端 release 指针和 Nginx 模板前，需分别验证安装包和 `nginx -t`。`deploy/split-release.mjs` 提供显式校验/激活流程；没有激活参数不切换。代码回滚不回滚数据库，兼容状态迁移是独立回退的前提。此文不代表已获上线授权。

2026-10-22 发布日志记录后端 `/opt/owqs/releases/20261022-d8e804a`、网页 `/opt/owqs/web-releases/20261022-d8e804a` 已分别激活；这是历史部署记录，不代表当前 HEAD 或实时线上版本。后端指针为 `/opt/owqs/current`，网页指针为 `/opt/owqs/web-current`。

`deploy/split-release.mjs` 默认仅校验安装包清单；显式 `--activate` 才执行切换，并要求已有可校验的同类回退版本。后端激活前用 SQLite backup API 备份，切换后重启并核验健康版本；网页切换后核验静态资源。验收失败会恢复原指针并再次验收，恢复失败则报错并留下审计记录。它不持续监测线上健康，也不自动回退数据库或 Nginx 配置。首次从旧整包迁入拆包布局需单独协调 Nginx 与双指针；回到旧整包时必须恢复旧 Nginx 配置。

## 运行与数据

- Node.js 24；进程由 `owqs.service` 管理，监听 `127.0.0.1:8788`，Nginx 提供公网 HTTPS。
- 赛事中心的 `EVENTS` 缓存使用同一 SQLite 文件内独立的 `events` 命名空间，不改账号或查询额度。赛程请求直接访问 Liquipedia，不占大神接口调度；`PUBLIC_ORIGIN` 默认用作上游 User-Agent 联系地址，也可通过 `EVENTS_CONTACT` 指定公开联系网址／邮箱。HTML 解析器已在构建时打包，不需在服务器安装 npm 依赖。
- 网站启动时检查近期数据时效，必要时补同步；持久化告警按比赛状态自适应更新：临近一小时或开赛后六小时内尚未结束的比赛、源站标记进行中的比赛约每 1 分钟，未来 24 小时内或刚结束的比赛约每 5 分钟，无近期比赛时每 15 分钟。进入更快更新窗口时主动唤醒，不依赖网页访问。进入赛事页自动请求刷新，前台页面每 30–60 秒读取最新缓存，也可手动刷新；服务器合并并发请求，至少间隔 30 秒，失败后至少退避 5 分钟并遵守 Retry-After。Bot 和网页通过共享接口按完整日期范围及赛事范围补查，默认仍为 OWCS。补查队列与分块结果也保存在 events 命名空间，重启／无人访问时由告警继续，使用同一上游间隔和退避。补查结果独立于近期快照，稳定历史日期缓存 24 小时；近期查询按相同比赛时效策略更新，跨午夜仍进行中的比赛不会直接降为 24 小时缓存。失败可保留 7 天旧结果；最多 8 个共享查询。近期旧数据最多保留 48 小时，失败或手动刷新受限时明确提示并保留当前内容。
- `/opt/owqs/releases/<版本>/` 保存白名单应用包，`/opt/owqs/current` 指向当前版本。更新时创建新版本目录，保留旧版本用于回滚。
- `/etc/owqs/config.json` 保存运行配置，权限 `root:owqs 0640`。禁止放进应用包、Git、静态目录或日志。
- `/var/lib/owqs/state.sqlite3` 保存账号、额度、API 密钥加密记录、任务、签名历史及持久化告警。SQLite 开启 WAL 和 FULL 同步；备份使用 SQLite backup API，不能只复制运行中的主文件而遗漏 WAL。
- 只运行一个网站进程；SQLite 事务队列、任务串行化和全站大神请求调度由该进程负责。不同用户最多并行执行四个后台对象，上游最多同时三个请求、启动间隔至少 500ms。
- `journalctl -u owqs` 查看服务状态；应用不打印账号、密钥、查询缓存或迁移正文。

整包 JSON 原子存储替代原 Durable Objects 的分片删除/写入过程。Cloudflare 保留原分片路径。查询内的玩家身份按上游 token 复用计算，不更改评分、缓存有效期或签名内容。

## 查询热开关与每日校验

Node 与 Cloudflare 共用 `src/query/control.mjs` 的控制规则。Node 通过 SQLite 的 `query-control` 命名空间、Cloudflare 通过 AuthDirectory Durable Object 存储中的 `query-control:` 独立前缀保存手动模式、自动暂停状态和每日检测记录。Cloudflare 的每日探测与原有账号清理共用 alarm，始终取较早的截止时间。查询准入、登录会话及账户能力字段使用同一持久化状态；切换立即生效，重启后保留。已创建的任务继续执行，历史、已保存结果和 AI 不受新查询开关影响。网页前台每 60 秒及重新获得焦点时同步能力状态。

Node 在服务器私有 `/etc/owqs/config.json` 配置 `"QUERY_PROBE_TAG": "daze#51307"` 后重启服务，Cloudflare 配置同名 Worker 私有变量以启用该探测账号；它不进入静态包或公开状态响应。每天北京时间 08:00 通过正式大神适配器调用一次 `/searchBnetAccount`（Node 使用同一全站调度器的低优先级通道），无用户任务、无额度消耗、无自动重试。启动错过当天检测时补检；发送前持久化当天记录，因此检测途中重启也不再发送当天探测。

首次必须返回完整匹配（忽略英文字母大小写）的 BattleTag 和非空 `customerToken` 才建立有效基线。此前空返回、账号未配置或核验失败均保持原状态。建立基线后，成功但缺少数据的返回触发自动暂停，有效匹配恢复自动状态；限流、凭证错误、网络故障、格式不符或其他玩家均保持原状态。更换探测账号、区服或赛季后重新核验基线。状态记录只保存时间和受控结果分类，不保存上游响应或 customerToken。

管理员页面新增“手动暂停”与“恢复自动控制”；对应接口 `GET/POST /api/v1/admin/query-control` 复用管理员 Cookie、同源检查和写入 CSRF，POST body 为 `{"mode":"paused"}` 或 `{"mode":"auto"}`。手动暂停优先，探测正常也不会解除；恢复自动控制采用最近自动状态，可能仍暂停。管理状态包含实际暂停状态、手动模式、检测结果、最近及下次检测时间；兼容字段 `forced` 固定为 false。

`QUERY_SUSPENDED` 冷开关已移除，两种部署均完全忽略该旧配置；管理员热控制和每日探测是唯一状态来源，无须修改配置或重启来解除手动暂停。首次没有持久化记录时默认为自动模式、查询开放，旧配置不会迁移为暂停状态；需要暂停时由管理员操作。每天只检测一次，发现故障和恢复最多可能延迟约一天。

## 预约推送（Web Push）

**状态：2026-10-20 已发布至腾讯云 `/opt/owqs/releases/20261020-c9a7a5f`。** 该版本分离快速 5v5／6v6 查询与替补判定；网站公网健康、版本标识与 Bot 插件热重载已核验。 预约路由、官方直播入口和全站三秒悬浮提醒已上线；服务器已生成并配置 `WEB_PUSH_*`，原配置项保留。公网健康、未登录鉴权、脚本与版本更新日志已核验。真实设备的系统通知及关页送达尚未完成验收，仍受浏览器授权、系统设置和推送网络影响。

比赛中心的开赛提醒由网站进程直接发送，不经过 Cloudflare。`server/runtime.mjs` 只有在 `WEB_PUSH_PUBLIC_KEY`、`WEB_PUSH_PRIVATE_KEY`、`WEB_PUSH_SUBJECT` 三项非空时才创建推送发送器；缺少任一项时提醒投递未启用，设备订阅接口返回 503；当前新代码允许独立保存账号预约，并通过 `deliveryReady` 明确没有可投递设备。配置只在启动时读取，首次启用或修改后必须重启 `owqs.service`。运行环境为 Node.js 24。

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
npm run server:build
npm run web:package
```

`dist/owqs-server.tar.gz` 包含 `server/`、`src/`、白名单 `backend-assets/` 出图媒体、初始化访问策略、最小 package.json 和安装包清单，不含完整 `public/`、`local/`、`.private/`、`.dev.vars`、Git 或研究数据。网页另打包为 `dist/owqs-web.tar.gz`，含 `public/` 和安装包清单，放入 `/opt/owqs/web-releases/<版本>/`。两包各有相邻 `.sha256` 文件；部署前核对校验值并校验清单，在新 release 目录解压，不覆盖数据库或配置。

`npm run server:start` 从 `OWQS_CONFIG` 和 `OWQS_DATA` 指定的目录启动；默认读取上述 Linux 路径。生产配置必须有 `PUBLIC_ORIGIN`、`PASSWORD_PEPPER`、`CACHE_SIGNING_KEY`、`API_KEY_ENCRYPTION_KEY`、`ADMIN_PASSWORD_HASH`；查询需要大神配置，AI 需要 `DEEPSEEK_KEY`。

## 公网 IP 与证书

`deploy/nginx-http.conf` 仅提供 ACME 校验与 HTTPS 跳转，`deploy/nginx-https.conf` 通过 8443 代理应用，当前 `PUBLIC_ORIGIN` 为 `https://106.55.47.68:8443`。Cookie 始终带 Secure。公网 IP 使用 Let's Encrypt shortlived 证书，必须启用 `owqs-cert-renew.timer` 每 12 小时检查并在续期后重载 Nginx。安全组需允许 IPv4 TCP 80 和 8443（来源 `0.0.0.0/0`）；IPv6 的 `::/0` 不会放行 IPv4。不要把应用的 8788 端口暴露公网。

`deploy/nginx-https.conf` 的 server 块启用 gzip：应用把脚本标为 `text/javascript`，且响应经过反向代理，因此 `gzip_types` 必须包含 `text/javascript`，并设置 `gzip_proxied any`；否则 JS/CSS 会以原始体积传输（首屏约 300 KB，压缩后约 92 KB）。修改后用 `nginx -t && nginx -s reload` 生效。

配置域名后，将 `PUBLIC_ORIGIN`、Nginx server_name、证书配置和 HTTP 跳转一起更新。原 IP 浏览器站点数据不会自动出现在新域名；云端账号历史保留。

非标准端口不替代内地网站正式对外服务所需的备案；域名准备好后再完善正式入口。

## 迁移 Cloudflare 账号与历史

`scripts/migrate-to-server.mjs` 必须显式设置 `OWQS_SSH_HOST`、`OWQS_SSH_KEY` 和 `OWQS_PUBLIC_ORIGIN` 后单独运行，不能加入构建或普通发布流程。

它下载并校验当前线上 Worker 代码，临时安装 15 分钟自动失效、使用专用随机 Bearer 密钥的导出桥；导出期间暂时暂停旧站写请求和告警。账号、原有密码 pepper、签名密钥、API 加密密钥和已签名历史在内存中组装，经 HTTPS 与 SSH 标准输入送到目标。不会复制本地私有文件。导入器先验证历史签名及分片完整性，目标数据库必须为空，随后通过单个事务导入；相同快照可幂等重试，不同快照拒绝覆盖。

无论导入成功与否，脚本都会恢复原 Worker 代码、删除临时密钥并比对源码摘要与绑定名称。仅源码备份保存在 `dist/migration-code-backup/`，不包含运行密钥或迁移数据；若进程意外终止，运行 `node scripts/migrate-to-server.mjs --restore` 恢复。不要在桥仍启用时启动第二次迁移。

运行中任务不迁移，迁移完成后重新发起；浏览器本地缓存可在新站登录后同步，但尚未上传旧站的本地历史需先在旧站完成同步。迁移是一次快照，之后两个站点的新增账号与历史分别保存，不会持续互相同步。

Bot 在账户 API 面板获取已有密钥，Base URL 指向新站点。字段与计费见 [BOT-API.md](BOT-API.md)。API 使用 Bearer 密钥，网页保持同源与 CSRF 校验。
