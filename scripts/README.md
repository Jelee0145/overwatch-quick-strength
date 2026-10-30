# 脚本入口

根目录保留 `package.json`、CI、服务器轮询和运维文档使用的稳定入口：构建、打包、部署、回退、同步、原生运行时检查。前后端源码已分到 `frontend/` 与 `backend/`；除根目录 `server/main.mjs` 这一个旧 systemd 启动路径的兼容入口外，不引入转发包装脚本。

- `build/`：页面文案、预加载清单、图表源适配和更新说明等构建 helper。
- `diagnostics/`：独立启动的预览、浏览器验收、历史与查询性能测量；不由构建、测试或部署自动启动。
- `runtime-check-suites.mjs`：四项 workerd 原生检查，由 `npm test` 统一调用。

诊断脚本可能依赖本地历史基线、Playwright 或显式参数；移动文件不代表它们已经获得访问生产或本机私有数据的授权。`upstream-*` 为独立并发测试工作，未纳入本次整理。

`deploy/split-release.mjs` 保留发布切换、回滚、SQLite 备份的导出与测试契约。当前腾讯云实际发布入口仍为 `scripts/deploy-local.mjs`，不能用前者替代。
