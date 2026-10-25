# OWQS 项目工作约定

- 主项目在仓库根目录；Cloudflare 构建根目录保持 `/`。
- 前后端分离与统一后端已完成，网页/API Bot 共用 `/api/v1`，业务计算在后端。架构以 `docs/unified-backend.md`、`contracts/openapi.yaml` 和当前代码为准；不要把旧设计讨论当作待实现任务。
- 前后端独立构建：`backend:build` / `web:build`；独立打包：`server:build` / `web:package`。腾讯云线上直接运行仓库 `/opt/owqs-work`：`owqs.service` 以它为工作目录，Nginx 网页根目录为 `/opt/owqs-work/public`。发布用 `node scripts/deploy-local.mjs`，回滚用 `git checkout <标签>` 后重跑同一命令；不再创建版本副本目录。边界见 `STANDALONE.md`。
- `local/` 是本机版，`source/` 是云端构建使用的源码快照。更新本机算法后，仅在确有需要时执行 `node scripts/sync-local.mjs`；不要无意覆盖云端改动。
- 账号接口、缓存签名和评分行为变化需运行 `npm run build`、`npm test`；打包检查为 `npm run check`，它只执行 dry-run。
- `.private/`、`.dev.vars`、`local/.private/` 包含凭证、日志或真实数据；严禁提交、上传、打印或放进 `public/`。
- 本地提交允许；推送必须取得用户的上线授权。推送到 `main` 会触发 GitHub Actions 构建与测试，服务器每 2 分钟轮询 `main`，本地测试通过后自动发布；线上直接运行 `/opt/owqs-work`，保留 `deploy/<日期>` 标签作为回滚点。自动发布日志见 `/var/log/owqs-auto-deploy.log`。预约推送（Web Push）于 2026-10-20 发布并配置，真实设备关页送达仍需验收。
- 删除文件前验证绝对路径和迁移校验。关机脚本、旧研究脚本不能作为启动入口或自动运行。
- 每次功能或修复发布使用 `feat:`／`feature:`／`fix:` 提交标题；提交正文每行 `Changelog: 中文用户可读更新说明`。构建自动生成日志与未读版本，禁止跳过更新说明；文档和纯维护提交不强制弹窗。用户说“发布”且未限定范围时，发布当前全部待发布改动。
