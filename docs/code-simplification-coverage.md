# 代码精简覆盖矩阵（2026-10-26）

基线为 `450dd5a`。本轮先新增护栏，再改任务创建与依赖方向，最后整理目录和独立格式化。下表记录实际断言，不把每个场景都改成整包快照。

| 兼容面 | 当前测试与断言 | 本轮处理 |
|---|---|---|
| 旧 `/api/*`、v1、账号/权限/响应 | `test/api/{cloud,api,unified-api,signature-transport}.test.mjs`：方法、Cookie/CSRF、Bearer、身份隔离、免费账号、任务响应与签名传输 | 保留现有语义断言；账号别名继续通过 legacy 路由翻译，未新增重复 application |
| 历史 full/slim、缓存/revision | `test/history/{history-analysis-api,history-performance,history-view,history-cache}.test.mjs`，`test/api/unified-api.test.mjs`：500 场、原批次证据、窗口、账号/密钥/版本隔离、命中与冲突、LRU 容量、压缩回传 | 已有覆盖充分，未重复实现缓存或把 HTTP 组合继续下沉 |
| 历史 v2 迁移/回退/恢复 | `test/history/cloud-history.test.mjs`：迁移失败回滚、签名字节与 revision、重新升级；`history-rollback.test.mjs`：多账号缺失/篡改批次/写入失败时全部原子回滚、dry-run 零改动、反复降级/升级等价 | 新增 4 项；存储格式及迁移算法不变 |
| 旧任务与 v2 额度/重启 | `test/query/task-policy.test.mjs`：4 类策略 × 5 种结果，重启后失败、取消、过期、建立中断、缓存命中；另测 terminal dedupe 到期与 legacy active 冲突 | 新增 21 项，先验证原实现，再共享 `createJob` 与策略函数 |
| 创建失败、退款重试、AI 与旧 checkpoint | `test/query/{unified-tasks,cache,query}.test.mjs`、`test/api/{cloud,api}.test.mjs`：建立失败补偿、AUTH 故障恢复、幂等退款、缓存等待、旧 checkpoint 升级和 AI 不重发 | 复用共享任务 env/ledger/request/upstream helper；保留不同策略 |
| 固定时钟赛事/提醒 | `test/events/{events-freshness,events-query,event-reminders,reminder-scheduler}.test.mjs`：注入 now、近期优先、补查公平性、故障退避、延期/取消/跨设备/重复投递 | 原有已覆盖；不新增仅改名的通用 clock 包装层 |
| 图表与 Bot | `test/api/api-chart.test.mjs` + `test/chart-baseline.json`：5v5/6v6 无媒体 fallback SVG SHA-256 golden；`test/services/services.test.mjs`：评分与 AI payload baseline；`api-capture.test.mjs`：DOM/CSS 和 data/review 分支执行 | 新增 1 项 SVG golden；真实媒体嵌入仍由已有断言保护，不宣称浏览器截图验收 |
| 依赖方向与来源 | `test/architecture/{architecture,source-layout}.test.mjs`：esbuild 实际 import graph、领域不反向依赖 api、services 无传输/DOM/Node、浏览器 bundle 无后端；来源与构建入口 | 新增 2 项图护栏；匹配投影移到 `src/services/match-view.mjs`，旧导出保留 |
| 发布、预算与格式 | `test/web/media.test.mjs`：300000-byte 启动预算；`tests/{build-boundaries,backend-package-runtime}.test.mjs`：独立包/导出/备份/回滚；`format:check`：作者维护的 JS/MJS | 复用现有门禁；CI 增加格式检查，`npm test` 继续承担预算检查 |

## 任务策略

| 任务记录 | 失败/取消/未完成过期 | 完全缓存命中 | 自动恢复暂停查询 |
|---|---|---|---|
| 旧网页（无 policyVersion 或 1） | 保留预占 | 退款 | 否 |
| 旧 API（api=true，无 policyVersion 或 1） | 退款 | 计费 | 是 |
| v2 网页 / API | 退款 | 退款 | 是 |
| AI | 退款；发出后不自动重发 | 可信 review 缓存不建任务、不预占 | 不自动重发 |

所有策略的建立中断均补偿预占；退款失败的持久重试、签名、历史归档和去重键契约保持原样。`createUnified` 与 legacy handler 保留各自的参数/身份/去重翻译，只共享机械创建入口。

## 范围与验收

- Prettier 3.9.10：2 空格、100 列、单语句分行；保留数据属性键引号，关闭嵌入语言改写。范围为 `src/`、`server/`、`web/*.js`、`scripts/` 和 Node 测试中的作者源码；CSS、HTML、Python 不在此门禁内。排除生成物、`source/`、`local/`、提示词、私有文件与本次开始前已有的 upstream 并发工作。
- 格式化提交 `63286bafd23e15162bc3ae4547a5837ff2558fd7` 记录于 `.git-blame-ignore-revs`；可用 `git blame --ignore-revs-file .git-blame-ignore-revs <file>`。
- 生成网页与格式化前比较：文件清单、哈希及内容完全相同，唯一差异为直接复制的 `event-reminders-sw.js` 排版；该文件 esbuild 规范化结果相同。源自空格依赖的抽取页文案替换已移至源组件，最终文案保持一致。
- 工作区完整测试 349/349，其中 14 项来自预先存在的未跟踪 upstream 工作，不属于本专项提交；单独运行项目领域测试与 tests/ 集成测试为 335/335。4 项 workerd、Bot capture 2 项、构建、独立打包与 Wrangler dry-run 已通过。
- 本地验证不包含线上部署、真实 Web Push 关页送达或新增浏览器截图验收。
