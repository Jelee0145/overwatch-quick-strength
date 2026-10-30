# OWQS 项目工作约定

- 主项目在仓库根目录；Cloudflare 构建根目录保持 `/`。
- 前后端分离与统一后端已完成，网页/API Bot 共用 `/api/v1`，业务计算在后端。架构以 `docs/unified-backend.md`、`contracts/openapi.yaml` 和当前代码为准；不要把旧设计讨论当作待实现任务。
- 前后端独立构建：`backend:build` / `web:build`；独立打包：`server:build` / `web:package`。`scripts/build.mjs` 只做入口编排，网页由 `scripts/build-web.mjs` 组装。腾讯云线上直接运行仓库 `/opt/owqs-work`：`owqs.service` 以它为工作目录，Nginx 网页根目录为 `/opt/owqs-work/public`。发布用 `node scripts/deploy-local.mjs`，回滚用 `git checkout <标签>` 后重跑同一命令；不再创建版本副本目录。边界见 `STANDALONE.md`。
- 历史存储 v2 会事务迁移为独立签名批次；回到整包存储的旧版本前，须停止服务并用当前代码的 `scripts/history-storage-rollback.mjs` 恢复旧格式，不能只 checkout。步骤与性能验收见 `docs/history-performance.md`。
- `local/` 是本机版；`source/` 是云端算法、数据、提示词、图表和媒体的权威源。网页基础 UI 定义在 `web/base/`，云端增量模块在 `web/app/`，页面模板为 `web/pages/strength.html`；`source/chart.js` 同时供浏览器与后端使用，构建不再替换图表或应用源码。`node scripts/sync-local.mjs` 默认只预检，只同步算法、数据和提示词；确需写入时用 `--apply --only=<file>` 逐文件执行。`local/chart.js` 与 `source/chart.js` 各自维护。
- 账号接口、缓存签名和评分行为变化需运行 `npm run build`、`npm test`；打包检查为 `npm run check`，它只执行 dry-run。
- `.private/`、`.dev.vars`、`local/.private/` 包含凭证、日志或真实数据；严禁提交、上传、打印或放进 `public/`。
- 本地提交允许；推送必须取得用户的上线授权。推送到 `main` 会触发 GitHub Actions 构建与测试，服务器每 2 分钟轮询 `main`，本地测试通过后自动发布；线上直接运行 `/opt/owqs-work`，保留 `deploy/<日期-时分>` 标签作为回滚点。自动发布日志见 `/var/log/owqs-auto-deploy.log`。预约推送（Web Push）于 2026-10-20 发布并配置，真实设备关页送达仍需验收。
- 删除文件前验证绝对路径和迁移校验。关机脚本、旧研究脚本不能作为启动入口或自动运行。
- 更新日志只提醒用户可以直接感知的功能或修复；用户看不到的改动，以及后端处理规则或调试相关改动，即使属于功能更新，也一律不写入用户更新日志、不触发更新提醒。
- 包含可提醒改动的发布使用 `feat:`／`feature:`／`fix:` 提交标题，正文用 `Changelog: 中文用户可读更新说明` 逐行描述符合上述规则的改动；混合提交不得把内部改动写入说明。只有不应提醒的改动时，使用 `chore:` 等不会自动生成更新日志的提交标题，且不写 `Changelog:`，避免构建将提交标题作为日志回退内容。文档和纯维护提交同样不强制弹窗。用户说“发布”且未限定范围时，发布当前全部待发布改动。
