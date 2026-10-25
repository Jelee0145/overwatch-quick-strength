# 统一后端与多端接入

网页与 API Bot 已统一使用 `/api/v1`，前后端分离已完成。PC 与手机仍是同一响应式网页；后端负责查询、评分、历史、锐评、账号额度、赛事和预约，客户端负责展示与交互。接口契约见 [OpenAPI](../contracts/openapi.yaml)。2026-10-22 腾讯云独立后端和网页拆包上线见 [发布日志](agent-update-log.md)；后续代码是否上线需另查部署版本。

## 接口和账号

- 网页以同源 HttpOnly Cookie 调用 v1；POST 仍校验 Origin、JSON 和独立的用户/管理员 CSRF。Bot 使用网站账号 Bearer Key，凭据只保存在 Bot 服务端。不同账号的任务与历史隔离，冲突的双重身份被拒绝。
- 同账号在各端共享查询额度、历史和预约；账号授权撤销即时作用于后续访问。`GET /api/v1/jobs` 返回活跃任务，新查询不等待网页缓存回传，关页后继续执行。
- `POST /api/v1/query` 接受 `Idempotency-Key` 或 `requestId`，同账号同标识同参数返回原任务，参数冲突为 409。去重与任务结果均有限期（约一小时）；到期后须发起新的明确操作，不能承诺永久去重。
- 查询预占额度；成功获取新对局/段位/参考历史扣一次。完全复用有效数据退预占，列表探测本身不另计费；失败、取消和未完成过期释放预占。轮询、历史读取、统计和出图不扣；同操作重试不重复扣。`quota/billingReason` 表达持久结算结果，跨存储暂时失败时可能先显示预占，恢复后再释放。
- 未绑定的 Bot 用户仍使用独立 free 服务账号与 Bot 本地每日限制，不保存共享服务账号下的个人历史；该模式未实现跨多个 Bot 实例的聊天用户额度同步。个人 Key 绑定后使用个人网站账号。
- 管理、注册和登录有 `/api/v1/auth/*`、`/api/v1/admin/*` 别名；旧 `/api/*` 保留兼容，不把旧客户端立刻停用。旧在途任务依其记录的策略结算。

## 历史分析

`POST /api/v1/history` 保留 `list/pull/push`，用于旧签名历史导入。服务端重新验签，忽略客户端索引，导入失败不删除本地副本。`GET /api/v1/history/accounts` 返回当前范围的账号目录。

`POST /api/v1/history/analysis` 接受 `battletag` 与 `options`（`start/statisticsRange/pool/side/strategy/estimate/revision`）。默认完整视图提供最多 500 场已分析历史、统计 model、可见十场 chartView、revision 和稳定 matchRefs。计算保持原始批次证据；不会把 500 场混成一个单批快照重新评分。网页以 `slim:true` 获取轻量全量索引和十场明细，按十场翻窗并预取相邻窗口；统计口径变化由服务端重算摘要。

网页专用投影将 `known` 压成段位数值、只发送一份 `combatPlayers` 和 `playerIndices`，保留桌面实际展示的 11 项统计，评分依据及段位原始数据由 `/matches/detail` 在展开时读取。`matchRefs` 只覆盖当前窗口，直方图使用服务端 45 桶；个人预测保留页面展示字段并在客户端复用 selected 职责。桌面与手机共享 `OWQS_SERVER_ANALYSIS`，分析内存和离线窗口各限 3 份，详情缓存限 2 份。机器人和未声明 slim 的调用方仍拿完整视图。

服务端响应缓存按用户、服务器、赛季、签名密钥代际、revision 和规范化选项隔离，限 48 MiB UTF-8 / 32 条；评分对象缓存将 start/statisticsRange 排除在键外，限 4 条及 32 MiB 计量预算（序列化 UTF-8 大小乘二，属于保守估算而非堆内存硬上限）。网页对象缓存不保留评分明细和签名原包；完整视图独立缓存。查询完成后，对不超过 200 场的已归档账号预热默认窗口；较大账号由首次请求建立缓存。Node 宿主对分析响应按 `Accept-Encoding` 协商 gzip/brotli/identity，压缩结果限 12 MiB / 32 条，设置 `Vary: Accept-Encoding`；Cloudflare 继续使用平台压缩。

云端历史使用版本 2 账号元数据及 `account:<id>:batch:<bid>` 独立签名批次 blob，push 只新增或淘汰相关批次，索引和容量通过轻量元数据更新；pull 只读当前页批次。旧账号在首次读取/写入时事务迁移，签名、revision、500 场 / 30 账号 / 每用户 32 MiB 限制保持原义。客户端 push 最多 8 包且请求小于 2.8MB；pull 验证整轮 revision 后一次合并、每账号一次 IndexedDB 写入。初始化优先读取当前 scope 的 cacheIndex legacyKey；无旧索引的快照仅作一次前缀游标迁移，完成标记落盘，不再 cache.getAll。仍用于缓存复用的旧签名快照保留，不能未经替代验证直接删除。

基准、验收与存储回退步骤见 [历史性能验收](history-performance.md)。迁移后回到旧代码前须先恢复旧存储格式，不能直接 checkout 后启动。

`POST /api/v1/matches/detail` 和 `/matches/review` 使用账号、原始 `mid` 和 revision，历史更新冲突返回 409。后端自行选取原始签名包，客户端提交的分数不作为信任依据。归档失败时，网页通过 `POST /api/v1/jobs/{id}/analysis` 分析本次已完成的签名结果，并显示归档警告；切换统计和锐评继续携带 `sourceJob`，不把旧历史当作新查询。该回退受任务保留期限约束。短期 job+编号仍兼容。新历史视图 JSON 与图表共用统计；旧 `jobs/{id}?render=svg` 继续固定展示、统计最近十场，不静默改变已安装 Bot 的图片口径。

浏览器缓存服务端结果供已打开页面断网回看，只有已缓存的相同选项/窗口可回看，仍需先建立登录会话；没有完整离线启动或离线评分。IndexedDB 不可用时退化为内存展示，不影响联网查询。历史容量仍为每账号 500 场、每用户 30 账号及 32 MiB 总限制。

## 预约与渠道

`/api/v1/events`、`/events/refresh` 和 `/events/reminders/*` 共用同一赛事来源、限流与账号预约。预约不再强制要求先订阅浏览器设备；响应中的 `deliveryReady/deviceCount` 表示是否存在可投递设备。没有设备时可保存预约，但不会收到系统通知。

现有投递渠道仍为 Web Push。Bot 读取/管理预约不代表支持主动发送聊天提醒；App 和小程序登录、推送渠道在其正式接入时实现。Cloudflare 没有 Node REMINDERS 绑定，必须检查 capabilities，不能将它当作腾讯云数据副本或透明回退服务。

## 构建与运行

| 命令 | 产物与副作用 |
|---|---|
| `npm run backend:build` | 从 source 生成后端算法/提示词/解析器与 renderer 媒体，不构建网页 |
| `npm run web:build` | 构建 public 网页，不改后端生成模块 |
| `npm run build` | 兼容总构建，依次生成后端和网页 |
| `npm run bot:capture` | 显式更新网页/Bot 展示组件包 website.json |
| `npm run server:build` | 后端独立包 dist/owqs-server.tar.gz，不含完整 public |
| `npm run web:package` | 网页独立包 dist/owqs-web.tar.gz |

`source/` 是现有线上算法规范源，`src/shared/` 为生成文件；不要手工改生成文件或隐式执行 `sync-local`。旧本机工具及 stdio Bot 作为独立旧模式保留，统一线上入口使用 API Bot。运行仍为一个 Node 24 实例和一个 SQLite 文件，尚未引入多实例锁或分布式队列。

后端默认仅服务 API、renderer 媒体只供内部出图。组合开发预览可设 `OWQS_SERVE_WEB=1`，网页根目录可设 `OWQS_WEB_ROOT`，renderer 可设 `OWQS_RENDERER_ROOT`。仓库内 `scripts/preview-unified.mjs` 使用内存数据库和合成数据，经桌面预览启动，不读取真实配置。

Nginx 模板将 `/api/*` 转发 Node、网页指向 `/opt/owqs/web-current/public`；保护页面使用内部会话校验并保留登录跳转，管理员登录 HTML 公共、操作 API 单独授权。保持原 origin、Host、Cookie、SW 根路径、gzip 和安全头。必须在目标服务器上通过 nginx 配置验证，再按单独授权发布。

## 精简与兼容

合并了网页 JSON 请求层和服务端参数规范化；任务创建、失败补偿及状态结算集中；网页退出评分执行链，构建提取后端准备阶段和完整查询轮询模块，减少字符串补丁。旧缓存握手仍仅服务存量任务；历史验签、通用本地存储、Bot 地图/图标、原始图表与展示组件仍有调用者，不作为死代码误删。

新 App/小程序只需接业务契约并增加平台登录和通知适配，不复制采集或评分。不在本次实现客户端实体、迁库、换框架或跨云同步。
