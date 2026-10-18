# 守望工具箱 Cloudflare 共享版

完整项目已迁移到 `D:\重装大礼包\project\owqs`；本机工具位于 `local/`，云端项目不修改它。`source` 保存评分、强度预测、图表和素材的独立源码快照，可在 GitHub／Cloudflare 上独立构建；仅替换认证、缓存及 API。本机算法更新后，可手动运行 `node scripts/sync-local.mjs` 同步白名单源码。

## 使用与管理

- `/`：统一登录后的工具箱主页，分别进入对局强度分析、英雄抽取和赛事中心。
- `/tools/strength`：原快速强度图，账号、查询、评分和浏览器历史沿用现有实现。
- `/tools/draw`：英雄轮盘、抽卡和老虎机自由切换，老虎机两侧固定 OW 图标，中央显示抽中英雄。工具页面及其直接 HTML 地址均检查账号授权。
- `/tools/events`：OWCS 近期赛程与赛果，按北京时间分组，支持日期、赛事、赛区及战队名称／简称筛选，手机底部导航可直接进入。只展示来源当前提供的近期比赛，不保证完整赛季；没有确认结束的过时对阵显示“待更新”。
- 对阵名称旁显示 Liquipedia 提供的队标，优先浅色背景版本；缺失或加载失败时使用中性占位，不影响名称和赛程显示。
- `GET /api/events`：仅已授权登录账号可读，不扣战绩或 AI 次数；返回 `matches`、`updatedAt`、`stale`、`source` 与 `coverage`。来源为 [Liquipedia MediaWiki API](https://liquipedia.net/api-terms-of-use)，内容按 CC BY-SA 3.0 标注，服务端将其筛选整理为 JSON，不把上游 HTML 放入页面。
- 赛事缓存由独立 `EVENTS / EventCenter` 共享持久化，5 分钟刷新一次，合并并发刷新；10 秒超时，失败至少退避 5 分钟并遵守 `Retry-After`。失败时可展示 24 小时内的旧数据并提示；没有可用缓存返回 503。页面可见时每 5 分钟检查，手动刷新也遵守缓存规则。`EVENTS_CONTACT` 可配置为项目公开联系网址／邮箱；默认使用服务端 `PUBLIC_ORIGIN` 或 Worker 当前站点地址作为 API User-Agent 联系信息。
- `/login`：邮箱＋密码申请和登录。申请由管理员人工核验邮箱归属。
- `/admin`：独立管理员密码登录；批准、拒绝、撤销授权、调整额度、处理密码重置申请。
- `/api/health`：只返回版本、构建时间与提交标识，可核验自动部署是否实际生效，不返回用户或凭证信息。
- 密码至少10字符，玩家登录30天，管理登录2小时。管理员生成的重置链接30分钟有效、只能使用一次。
- `access-policy.json` 仅初始化一次；部署不会覆盖后台授权记录。默认每天查询10次、AI100次，北京时间零点重置。
- 每用户网页端同时一个查询和一个AI任务，不同用户独立执行。重复点击复用任务；限流暂停查询，30秒后可点击继续。Bot 查询 API 每个密钥最多同时保留 5 个未完成任务。
- Bot 查询 API：`POST /api/v1/query` 创建查询，`GET /api/v1/jobs/{id}` 读取状态与结果。每个账户只有一个 API 密钥，账户页默认隐藏，可查看、复制和重新生成；重新生成后旧密钥立即失效。接口使用 `Authorization: Bearer <密钥>`，供 Bot 后端服务器调用，不开放浏览器跨域直连。
- API 查询场次只决定最近 5/10/20 场的搜索范围；分析图表固定最近 10 场，统计范围可选全部/5/10/20。每个成功查询扣 1 次查询额度，与场次及缓存命中无关，纯缓存结果也扣 1；失败、取消或最终超时释放预留，不扣额度。每个密钥最多 5 个未完成任务，超过返回 HTTP 429。
- 同登录账号的战绩历史和原始签名包保存在现有 SQLite-backed Durable Objects，浏览器 IndexedDB 保留本地副本；进入对局分析、打开历史和完成查询时同步。新查询由服务端自动归档，旧浏览器历史上传后重新验签合并。同步失败保留本地数据，可在历史弹窗中重试。
- “历史记录”按当前登录用户、服务器、赛季和战网账号隔离；每战网账号最多保留最近500场，并受云端每登录账号总计32 MiB、30个账号归档（跨服务器和赛季合计）限制。成功查询按对局ID合并，以签名内查询时间和固定批次规则决胜，失败不会覆盖旧历史；旧设备需至少打开一次对局分析完成补传，已清理或被覆盖的本地记录无法补回。锐评、抽签记录、个人设置及临时缓存仍保存在本机。
- 图表按时间从左到右排列，可按住拖动、使用滚动条或左右按钮回看。“查询场数”仅控制最近5/10/20场的查询范围，已有有效对局复用，仅补查缺少的数据并合并历史；不会改变图表固定10场的可见窗口。统计范围默认全部，可选5/10/20，有限范围以窗口最右侧为终点。PNG/SVG导出当前可见窗口，JSON导出当前账号保留的全部历史。已成功同步的战绩历史可在另一设备登录同账号后恢复；未完成补传的旧本地历史仍应保留原浏览器数据。JSON 导出不含签名包，仍用于查看和分析，不作为可信恢复入口。
- 请求不自动重复发送AI，超时后可能已经产生供应商费用；请确认后手动重试。网站AI额度失败时返还，不代表供应商退款。

### Bot 查询 API

网站 API 版 AstrBot 插件见 [安装与指令](plugins/astrbot_plugin_owqs_api/README.md)：配置网站地址和账户 API 密钥，支持 `/owqs 绑定`、`/owqs 查询`、`/owqs 取消`，以及查询／绑定／取消 LLM 工具。查询和评分由网站完成，Bot 默认渲染并发送最近 10 场强度图片，出图失败时回复文字摘要；`python scripts/build-api-plugin.py` 生成无密钥 ZIP。

网页先加载当前页面和可见图表需要的资源，页面加载完成并空闲 3 秒后，再逐份预取其他页面脚本、地图预览和英雄头像，复用浏览器持久缓存。后台请求为低优先级、单路、每次访问最多 8 MiB；操作页面、查询或导图时暂停，省流量／2G／离线时不启动。资源按内容版本更新，高清导出图片仍按需读取；浏览器可自行清理缓存，不影响正常访问。预加载不包含账号、接口响应或历史数据。

完整接口字段、状态、错误码、额度规则和代码示例见 [BOT-API.md](BOT-API.md)。

账户页右上角“API”打开密钥面板。密钥默认隐藏，可查看、复制或重新生成；服务端使用专用的 `API_KEY_ENCRYPTION_KEY` 加密保存明文，鉴权只使用密钥摘要。重新生成会立即删除旧密钥索引。

```http
POST /api/v1/query
Authorization: Bearer owqs_...
Content-Type: application/json

{"battletag":"昵称#12345","limit":10,"mode":"fast","statisticsRange":"all"}
```

创建成功返回 `200` 和任务 ID：

```json
{"id":"…","state":"running","status":"/api/v1/jobs/…"}
```

`limit` 仅接受 `5`、`10`、`20`，表示搜索范围；`mode` 为 `fast`/`slow`（也接受 `supplementOtherMatches` 布尔值）。可选 `statisticsRange`（`all`/`5`/`10`/`20`）、`side`（`all`/`T`/`E`）、`strategy`（`legacy`/`role`/`highest`）和 `estimate` 布尔值。分析结果的图表窗口固定最近 10 场，`statisticsRange` 只影响统计范围。

```http
GET /api/v1/jobs/{id}
Authorization: Bearer owqs_...
```

完成后返回 `state: "done"`、原始对局数据 `result` 和服务端计算的分析 `analysis`，并自动写入密钥所属账户的历史。失败、取消或超时返回终态和 `quota: "released"`；运行、暂停任务显示 `quota: "reserved"`。可选 `POST /api/v1/jobs/{id}/cancel` 取消任务。接口不返回 CORS 头，浏览器应通过自己的后端代理调用。

## 构建与部署

腾讯云独立网站、SQLite 持久化、HTTPS 与 Cloudflare 账号历史迁移见 [STANDALONE.md](STANDALONE.md)。独立网站继续提供现有 Bot 查询 API。

战绩获取、数据整理和分析计算的仓库内复用入口、调用示例及平台边界见 [SERVICES.md](SERVICES.md)。网页、Bot 与 AI 锐评共用服务模块，支持直接分析已有数据。

`npm ci`、`npm run build`、`npm test`、`npm run check`。`npm run login` 打开官方OAuth，登录文件与日志留在项目私有目录。

`npm run deploy` 发布 Workers 和静态资源、自动创建 SQLite-backed Durable Object 绑定。

Cloudflare Workers Builds 绑定私有仓库的 `main` 分支；根目录 `/`，构建命令 `npm run build && npm test`，部署命令 `npm run deploy:ci`。临时429/502/503/504网络错误最多重试3次；权限、构建或语法错误不重试。不用 GitHub Actions 保存部署密钥，不启用预览分支部署。平台运行 Secrets 与 Git 仓库分离。

部署后由使用者运行 `scripts/Setup-Admin.ps1` 的隐藏密码窗口；该窗口将本机已加密保存的大神/DeepSeek凭证直接传入 Wrangler 的标准输入，写入 Workers Secrets。管理员密码仅生成散列；本地备份为 Windows DPAPI 加密的 `.private/cloud-secrets.dpapi`。

首次配置需要这些 Secrets：`DASHEN_ROLE_ID`、`DASHEN_TOKEN`、`DEEPSEEK_KEY`、`PASSWORD_PEPPER`、`CACHE_SIGNING_KEY`、`API_KEY_ENCRYPTION_KEY`、`ADMIN_PASSWORD_HASH`。`DASHEN_SERVER`和`DASHEN_DTS`是普通运行配置。`API_KEY_ENCRYPTION_KEY` 只用于加密账户 API 密钥，部署前必须配置；更换后已生成的密钥无法查看，需要用户在账户页重新生成。

不要把 `.private`、`.dev.vars`、`.wrangler`、npm缓存或本机凭证文件上传到静态目录。`public` 仅由白名单构建生成。

为已有部署启用 Bot 查询 API 时，只需追加 `API_KEY_ENCRYPTION_KEY`：`node scripts/wrangler.mjs secret put API_KEY_ENCRYPTION_KEY`，按提示隐藏输入。不要为此重复运行首次初始化窗口。

轮换 Cloudflare API 令牌可通过官方 Wrangler `secret put` 隐藏输入完成。不要重复运行首次初始化窗口来轮换 Token：它同时更新 pepper/签名，会使旧密码和缓存失效。

## 验证边界

单元与模拟上游测试、Wrangler dry-run、本地运行时测试不等于云端真实接口通过。正式使用前必须在云端完成真实查询、真实锐评和多人并发验收。免费额度不足或网易大神拒绝 Cloudflare 请求时不自动购买或搭建外部后端。

## 地图素材与加载

云端网页不加载本机的内嵌 `art.js`，也不请求本机 `/api/map-art`。地图、头像和段位图标由免费 Workers Static Assets 提供；脚本／样式与图片均使用内容哈希，一年 immutable 缓存。账号与 API 响应不公共缓存。地图仅加载当前图表需要的素材，最多并行四张；导出时使用较高清图片并内嵌，下载文件可以独立打开。

`source/media/manifest.json` 覆盖全部133条地图记录，`coverage.json` 保存来源、同名别名和缺失项。现已取得131条真实素材；VPP Green Room、寺院没有可核实的来源，显示统一背景。预览最长边960，导出1920，不放大小图。日常 CI 使用已提交的 WebP，不请求外站。地图目录更新后，在本机用带 Pillow 的 Python 手动运行 `scripts/prepare-media.py`，检查覆盖报告，再构建部署；该脚本原图缓存仅留在 `.private`。

性能比较使用本机独立 Playwright（安装环境提供，不属于线上依赖），`node scripts/speed-check.mjs`，基线网页需提前保存在 `.private/speed-baseline/public`。使用匿名模拟数据与同样网络条件，结果保存在 `.private/speed-results.json`，不会上传或暴露为网站功能。2026-10-12 最终比较：6 Mbps、100 ms 延迟、4倍 CPU 降速，各5次；可操作中位数15.719秒→2.620秒，完整图表15.863秒→3.205秒，传输8,592,280→626,424字节。以上为本地可复现基准，不代表每位用户的实际延迟，也不包含上游查询／AI耗时。

## 快／慢查询与迁移

默认不勾选“补充其他对局”为快查询，勾选后按缺口补采；两种模式共用签名缓存。完整本地验收见 `LOCAL-FAST-SLOW-ACCEPTANCE.md`。目前仅有本地实现，未推送上线。

重装、凭证及 Git 恢复详见 [迁移与重装恢复.md](迁移与重装恢复.md)。`.private` 中的会话工作与历史导出仅作私有资料，不作为正式入口。

## 更新日志

登录后自动显示当前版本更新日志，点击“我知道了”后按登录用户在此浏览器保存已读状态。刷新不再自动弹出，右上角“更新日志”可随时重看；每次功能或修复提交自动生成新的日志版本并重新提示未读用户。清理站点数据或换浏览器会再次显示。

更新日志由 `scripts/release-notes.mjs` 从 baseline 后的 `feat:`／`feature:`／`fix:` 提交自动生成；正文使用 `Changelog: 中文用户可读说明`，支持多行。旧版本记录保存在 `web/release-notes.json`。日志内容变化才更新已读版本；维护提交不重复提示。当前页面每5分钟及回到标签页时检查更新，读取状态仍按账号与浏览器隔离。

## 英雄抽取与头像维护

三种形式共用等概率英雄池，支持全部／重装／输出／支援筛选；抽取期间锁定形式和职责切换。抽取记录按登录账号保存到现有浏览器 IndexedDB，最多保留 50 次，换设备或清理站点数据不会恢复。轮盘与老虎机减速揭晓，抽卡翻牌揭晓；系统要求减少动画时使用简短展示。

`web/draw/heroes.json` 保存英雄名单、职责、头像来源和 SHA-256；`web/draw/portraits/` 保存透明 PNG 原件。当前覆盖 54 位英雄：复用 49 张旧透明头像，补齐血律、D.Mon、死怨、西拉，毛加旧不透明头像已换为官方透明版本。构建将头像复制为带内容哈希的站内资源，页面不依赖外站图片请求。

手动维护命令为 `python -X utf8 scripts/update-draw-heroes.py`（需要 Pillow）。它核对暴雪官方英雄目录，仅下载缺少或不透明的头像，不覆盖有效透明图片；遇到尚未配置中文名的新英雄会停止，避免静默遗漏。该脚本不属于构建或发布步骤。

## 品牌与界面文案

云端统一使用“狸狸天眼查”和 `web/fox.svg` 像素狐狸。`scripts/ui-copy.mjs` 在构建末尾统一转换界面文案，保持元素 ID、接口字段和数据计算不变；原本机界面与 AI 提示词不参与转换。修改文案时同时检查手机摘要、动态按钮及导出名称，执行界面与算法回归。
