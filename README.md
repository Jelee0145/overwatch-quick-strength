# 快速强度图 Cloudflare 共享版

完整项目已迁移到 `D:\重装大礼包\project\owqs`；本机工具位于 `local/`，云端项目不修改它。`source` 保存评分、强度预测、图表和素材的独立源码快照，可在 GitHub／Cloudflare 上独立构建；仅替换认证、缓存及 API。本机算法更新后，可手动运行 `node scripts/sync-local.mjs` 同步白名单源码。

## 使用与管理

- `/login`：邮箱＋密码申请和登录。申请由管理员人工核验邮箱归属。
- `/admin`：独立管理员密码登录；批准、拒绝、撤销授权、调整额度、处理密码重置申请。
- `/api/health`：只返回版本、构建时间与提交标识，可核验自动部署是否实际生效，不返回用户或凭证信息。
- 密码至少10字符，玩家登录30天，管理登录2小时。管理员生成的重置链接30分钟有效、只能使用一次。
- `access-policy.json` 仅初始化一次；部署不会覆盖后台授权记录。默认每天查询10次、AI100次，北京时间零点重置。
- 每用户同时一个查询和一个AI任务，不同用户独立执行。重复点击复用任务；限流暂停查询，30秒后可点击继续。
- IndexedDB 保存对局、签名及锐评。清理浏览器数据或换设备需要重新查询。云端仅保存账号、会话、额度和短期任务，任务完成/失败一小时删除。
- “历史记录”列出当前用户、服务器及赛季在本浏览器查询过的账号；每账号独立保留最近500场，不随复用缓存淘汰。成功查询按对局ID合并，失败不会覆盖旧历史；首次升级迁入仍存在的旧快照，已被覆盖的历史无法补回。
- 图表按时间从左到右排列，可按住拖动、使用滚动条或左右按钮回看。“查询场数”仅控制最近5/10/20场的查询范围，已有有效对局复用，仅补查缺少的数据并合并历史；不会改变图表固定10场的可见窗口。统计范围默认全部，可选5/10/20，有限范围以窗口最右侧为终点。PNG/SVG导出当前可见窗口，JSON导出当前账号保留的全部历史。历史保存在浏览器而非云端，清理站点数据或换设备后无法恢复。
- 请求不自动重复发送AI，超时后可能已经产生供应商费用；请确认后手动重试。网站AI额度失败时返还，不代表供应商退款。

## 构建与部署

`npm ci`、`npm run build`、`npm test`、`npm run check`。`npm run login` 打开官方OAuth，登录文件与日志留在项目私有目录。

`npm run deploy` 发布 Workers 和静态资源、自动创建 SQLite-backed Durable Object 绑定。

Cloudflare Workers Builds 绑定私有仓库的 `main` 分支；根目录 `/`，构建命令 `npm run build && npm test`，部署命令 `npm run deploy:ci`。临时429/502/503/504网络错误最多重试3次；权限、构建或语法错误不重试。不用 GitHub Actions 保存部署密钥，不启用预览分支部署。平台运行 Secrets 与 Git 仓库分离。

部署后由使用者运行 `scripts/Setup-Admin.ps1` 的隐藏密码窗口；该窗口将本机已加密保存的大神/DeepSeek凭证直接传入 Wrangler 的标准输入，写入 Workers Secrets。管理员密码仅生成散列；本地备份为 Windows DPAPI 加密的 `.private/cloud-secrets.dpapi`。

首次配置需要这些 Secrets：`DASHEN_ROLE_ID`、`DASHEN_TOKEN`、`DEEPSEEK_KEY`、`PASSWORD_PEPPER`、`CACHE_SIGNING_KEY`、`ADMIN_PASSWORD_HASH`。`DASHEN_SERVER`和`DASHEN_DTS`是普通运行配置。

不要把 `.private`、`.dev.vars`、`.wrangler`、npm缓存或本机凭证文件上传到静态目录。`public` 仅由白名单构建生成。

轮换 API 密钥可通过官方 Wrangler `secret put` 隐藏输入完成。不要重复运行首次初始化窗口来轮换 Token：它同时更新 pepper/签名，会使旧密码和缓存失效。

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

登录后自动显示当前版本更新日志，点击“我知道了”后按登录用户在此浏览器保存已读状态。刷新不再自动弹出，右上角“更新日志”可随时重看；新版本修改 web/changelog.js 的版本标识后重新提示。清理站点数据或换浏览器会再次显示。
