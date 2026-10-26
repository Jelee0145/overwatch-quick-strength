# 代码精简专项交接（2026-10-26）

## 当前状态

- `confirmed-current`：仓库 `D:/project/owqs`，分支 `codex/code-simplification-remaining`，基线 `450dd5a`；本轮全部为本地提交，没有推送、合并 main 或部署。
- `verified`：Phase 0–4 的本地实现与护栏已完成；最终实现提交 `7b1d1cc`，其后为本次计划/覆盖矩阵/交接更新。下一次操作前用 Git 核对实际 HEAD，勿把本记录当线上 revision。
- 保留本轮开始前的 `scripts/upstream-limit-scan.mjs`、`upstream-scan-rate.mjs`、`upstream-scan-shared.mjs`、两项对应 test 文件和 `docs/query-rate-limit-handoff.md`，未修改或纳入专项提交。原计划/交接内容基于当前代码继续更新，没有丢弃其约束。
- 无当前外部阻塞；没有启动常驻服务、临时 worktree 或生产探测。

## 本轮提交与成果

| 提交 | 结果 |
|---|---|
| `c149adf` | 先加依赖方向、历史回退矩阵、任务策略矩阵、SVG golden，抽取任务测试 helpers |
| `b18727c` | 共用 createJob/persistCreation，集中策略判定；对局投影归 services，api/match 保留兼容导出 |
| `de5fa7e` | 45 个 Node 测试按领域归档，4 个构建 helper 与 6 个诊断脚本分层；更新引用及 package 入口；配置 Prettier |
| `63286ba` | 纯格式化独立提交，已记入 .git-blame-ignore-revs |
| `7b1d1cc` | 格式门禁/CI、保留大整数属性键引号、修复格式敏感断言、文案归组件、重生成等价 Bot capture |

- 任务创建只共享机械过程；legacy / v2 的参数、去重、缓存计费、失败退款、暂停恢复差异保留。明确矩阵见 [覆盖说明](code-simplification-coverage.md)。
- v1/旧赛事已共用 application，账号别名已有 legacy 翻译；未为了统一新增抽象。历史 HTTP 组合保留在 api，缓存和评分对象留在 history。
- `deploy/split-release.mjs` 保留导出与集成测试契约；腾讯云实际入口仍是 deploy-local，不改发布流程。
- 测试根目录仍保留跨宿主/诊断共享的 fixture 与 golden JSON；helpers 共享 storage 和任务环境，已有领域时钟不另造包装。
- Prettier 范围为作者云端 JS/MJS 与 Node 测试；source/local、提示词、生成物、私有文件和原有 upstream 工作排除。CSS/HTML/Python 不在本次格式门禁范围。

## 验证

- 基线：321 项工作区测试 + 4 项 workerd，通过。
- 最终：`npm test` 349/349（含原有 14 项未跟踪 upstream 测试）；提交内领域/集成测试单独运行 335/335，0 跳过/失败。
- 四项 workerd 原生检查：上游请求、SQLite 历史事务、分析/固定十场/黄金评分、赛事共享缓存与 durable alarm，通过。
- `npm run format:check`、`npm run build`、`npm run server:build`、`npm run web:package`、`npm run check`，全部通过。check 为 Wrangler dry-run，没有发布。
- `npm run bot:capture` 与两项 capture 执行测试通过；相对基线，version/DOM/CSS 一致，脚本经 esbuild 规范化后相同。
- 网页文件清单、哈希和内容与格式化前一致，只有直接复制的 Service Worker 排版不同；其 esbuild 规范化输出一致。对局页启动预算 231861 / 300000 bytes，继续由现有媒体测试门禁保护。
- 图表：两项模式的无媒体 fallback SVG 摘要不变；真实媒体嵌入、评分/AI payload 基线通过。
- Windows 沙箱首次执行出现 HTTP 监听/符号链接 EPERM；允许本地测试权限后全部通过，未跳过断言或将环境失败计为成功。

## 边界与后续

本专项无剩余本地实现项。未推送/部署，未做新的真实浏览器截图、真实设备关页 Web Push 或生产运行验收。这些不能从本地自动测试推出。

需要上线时，先核对用户要发布的范围（尤其原有并发测试改动）、分支 diff、最终 revision 和验证记录；推送 main 会触发 CI 及服务器轮询发布，必须有用户的上线授权。历史 v2 与旧代码之间回退仍须停服务、备份并运行当前 rollback 工具，不能只 checkout。

下一位接手先执行 `git status -sb`、`git log -6 --oneline`，阅读 [计划](code-simplification-plan.md)、[覆盖矩阵](code-simplification-coverage.md)、AGENTS.md、统一后端说明和当前代码。测试路径见 `test/README.md`，脚本入口见 `scripts/README.md`。不得使用旧的 main 状态、平铺测试路径或历史 303/312 测试数作为当前验收结论。
