# OWQS 项目工作约定

- 主项目在仓库根目录；Cloudflare 构建根目录保持 `/`。
- `local/` 是本机版，`source/` 是云端构建使用的源码快照。更新本机算法后，仅在确有需要时执行 `node scripts/sync-local.mjs`；不要无意覆盖云端改动。
- 账号接口、缓存签名和评分行为变化需运行 `npm run build`、`npm test`；打包检查为 `npm run check`，它只执行 dry-run。
- `.private/`、`.dev.vars`、`local/.private/` 包含凭证、日志或真实数据；严禁提交、上传、打印或放进 `public/`。
- 本地提交允许；推送会触发 Cloudflare 自动部署，必须取得用户的上线授权。目前快慢查询仍处于本地待上线状态。
- 删除文件前验证绝对路径和迁移校验。关机脚本、旧研究脚本不能作为启动入口或自动运行。
