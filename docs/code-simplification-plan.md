# 代码精简专项计划（2026-10-25 校准）

状态：Phase 1 的目录分层、security 拆分、v1 路由表、旧接口适配层和 auth/tasks 分派已完成；Phase 2 的懒加载器、运行时检查和测试夹具合并已完成；Phase 3（移除构建期源码手术）与 Phase 4 的文档、来源矩阵和生成物清理已在工作树完成。尚未提交、推送或部署。剩余项仅有任务创建/额度结算收敛和全量格式化，本文其余部分保留作为范围记录。上一版写于 2026-10-22；本文按当前工作树校准。

## 0. 校准结论

方向仍然成立：减少重复规则、移除构建期源码手术、把入口/状态机/纯计算分开。

需要改的地方有四处：

1. **构建入口已拆分**：`scripts/build.mjs` 只编排后端与网页，`scripts/build-web.mjs` 组装网页。云端基础 UI 在 `web/base/`，增量模块在 `web/app/`，页面模板为 `web/pages/strength.html`；`source/` 只保留算法、数据、提示词、图表和媒体。
2. **同步入口已收窄**：`scripts/sync-local.mjs` 默认只预检，只同步算法、数据和提示词，写入必须显式 `--apply --only=<file>`。`source/chart.js` 是云端图表权威源，`local/chart.js` 独立维护，不互相同步。
3. **历史存储 v2 是跨版本边界**：本轮不能改 blob 格式、迁移顺序或回退语义；回到不兼容的旧代码前，必须先停服务、备份 SQLite，再用 `scripts/history-storage-rollback.mjs` 恢复旧格式。它并非“不可回退”，但不能只 checkout。
4. **发布方式变了**：线上直接运行 `/opt/owqs-work`；推送到 `main` 会触发服务器轮询自动发布。重构不能像旧计划那样“最后再统一验证”，必须分支隔离、阶段门禁。

已经完成、不要重做的部分：

- `src/history/view.mjs`、`cache.mjs`、`response.mjs` 已经把历史投影、响应缓存和预热的思路拆出来了。
- `server/analysis-encoding.mjs` 已把 Node 压缩单独隔离。
- `src/events/freshness.mjs` 已把赛事刷新间隔从 `EventCenter` 中抽出。
- `scripts/verify-release.mjs` 已在临时 worktree 里执行 `npm ci`、构建和完整测试。
- Phase 3 已完成：`scripts/build.mjs` 为薄入口，`scripts/build-web.mjs` 组装网页；`scripts/build-patch.mjs` 及其测试已删除。
- 网页基础 UI 在 `web/base/app.js`，`web/app/timeline.js`、`export.js`、`query.js`、`boot.js` 由 `boot.js` 显式串联；页面模板为 `web/pages/strength.html`。
- `source/chart.js` 为浏览器与后端共用；可选窗口、统计和地图素材参数不改变 API/Bot 默认输出。
- `sync-local` 已收窄为算法、数据和提示词；`local/` 不再进入云端网页构建。

结论：Phase 3 的来源拆分与构建期源码手术已完成；后续重点转向 Phase 0–2 的结构收敛与 Phase 4 的护栏。历史存储 v2 仍冻结，不能借重构改格式。

## 1. 真实目标

不是“把行数变少”，而是降低四类长期成本：

1. 同一规则有多份实现，改一处必须记得改另外几处。
2. 构建期源码手术：已由 Phase 3 移除；`build.mjs` 只编排，`build-web.mjs` 显式拼接模块并替换页面占位符。
3. 入口与状态机混在一起：HTTP 路由、鉴权、额度、任务生命周期、存储细节堆在少数大函数里。
4. 来源不清晰：`source/`、`local/`、`web/`、`src/` 各自承担什么，哪些是生成物，哪些可以手改。

成功标准：

- 每个业务规则只有一个权威实现；兼容层只做翻译，不复制规则。
- 云端网页的构建输入只有“算法源 + 网页源”，不再对本机版或源码快照做字符串改写（Phase 3 已达成）。
- 每个模块只有一个变更理由，依赖方向可以用测试检查。
- 所有现有功能、接口形状、旧任务/旧签名/历史 v2 兼容性保持不变。
- `npm test`、构建、独立打包、dry-run 全部通过，启动预算不退化。

## 2. 现状盘点（2026-10-25）

### 2.1 规模与生成物

| 区域 | 文件数 | 代码行数（静态统计） | 性质 |
|---|---:|---:|---|
| `src/` | 49 | 3,467 | 云端运行时源码 |
| `server/` | 12 | 639 | Node 宿主适配 |
| `web/` | 59 | 1,607 | 云端网页源码：基础 UI、应用模块、页面模板与增量脚本 |
| `scripts/` | 46 | — | 构建、发布、迁移、诊断 |
| `test/` + `tests/` | 47 | 5,235 | Node 测试与夹具 |
| `source/` | 9 个代码文件 + 资源 | 1,816 | 云端算法、数据、提示词、图表、媒体 |
| `local/` | 21 个代码文件 + 资源 | 2,998 | 独立本机版 |
| `src/shared/`、`src/release.mjs`、`src/prompt.mjs`、`public/` | — | 生成物 | 已被 `.gitignore` 忽略 |

`src/` 仍然是 1 空格缩进、多语句一行的高密度写法。行数低估了阅读成本。

### 2.2 主要复杂度热点

| 热点 | 位置 | 当前问题 |
|---|---|---|
| 构建期源码改写 | 已移除（Phase 3） | `scripts/build.mjs` 只编排；`scripts/build-web.mjs` 显式拼接 `web/base` 与 `web/app` 模块，仅替换页面占位符 |
| 基础 UI 来源混杂 | 已拆分（Phase 3） | 基础 UI 在 `web/base/`，增量模块在 `web/app/`，页面模板在 `web/pages/`；`source/` 只保留算法与素材 |
| 本机同步覆盖云端 UI | 已收窄（Phase 3） | `sync-local` 只同步算法、数据和提示词；默认预检，写入需 `--apply --only=<file>`；图表不参与同步 |
| 两套代码树仍有分叉 | `source/` 与 `local/` | 网页 UI 已分家；共享算法仍有少量差异，忽略行尾后约 core 22 行、chart 19 行，包含 `QS.summarize` 与固定坐标轴等云端能力 |
| 旧接口与 v1 并行 | `src/worker.mjs:18-48`、`src/api/v1.mjs` | `/api/*` 与 `/api/v1/*` 各有一套路由、参数翻译和任务策略 |
| HTTP 层承载历史策略 | `src/api/v1.mjs:42-64` | 历史分析分支约 22 行，包含 catalog 查询、revision 冲突、响应缓存、slim 投影和预热入口 |
| 任务状态机单函数 | 已拆分（Phase 1） | `src/actors/tasks.mjs` 用路由映射分派到小处理器 |
| 账号状态机单函数 | 已拆分（Phase 1） | `src/actors/auth.mjs` 用路由映射分派到小处理器 |
| 安全模块职责混杂 | `src/security.mjs` | 错误、随机数/摘要、密码、Cookie、响应、快照签名、密钥加密、Blob 存储混在 27 行内 |
| 历史模块边界 | `src/history/` | 存储、分析、视图、缓存与预热分文件 |
| 赛事模块 | `src/events/` | center、queries、parser、filter、broadcasts、source、freshness 同目录 |
| 懒加载器重复 | 已合并（Phase 2） | `web/lazy-loader.js` 按需加载 extras、手机布局和提醒 |
| 运行时检查入口重复 | 已合并（Phase 2） | `scripts/runtime-check-suites.mjs` 按 suite 运行四个原生检查 |
| 测试夹具重复 | `test/*.test.mjs` | 至少 6 个测试各自实现 fake storage / env / clock |
| 脚本继续膨胀 | `scripts/` | 已增至 46 个；发布、迁移、诊断、构建混在同一层 |

### 2.3 必须保留的兼容面

这些不是“旧代码”，不能按死代码清理：

- 旧 `/api/*` 路由、旧网页客户端、旧在途任务的结算策略。
- `policyVersion` 1/2 的任务恢复与 `restoreQuery` / `upgradeQuery`。
- 签名历史包、签名缓存记录、快照作用域与账号隔离。
- 历史存储 v2 的账号元数据、独立批次 blob、事务迁移、revision 和 `history-storage-rollback.mjs` 的回退等价性。
- Bot 的固定十场 SVG 语义与 `website.json` 抓取形状。
- 腾讯云单目录运行 `/opt/owqs-work`、Nginx 静态根、自动发布与 `deploy/<日期-时分>` 回滚标签。
- Cloudflare 根目录构建。
- `local/` 本机版独立可用；`source/` 仍是算法、数据、提示词、图表和媒体权威源；网页基础在 `web/base/`，`src/shared/` 是生成物。

## 3. 目标架构

### 3.1 分层与领域切片

```text
浏览器 / Bot
    │
    ▼
src/api/            /api/v1 路由表、历史分支、旧 /api/* 兼容翻译（行为冻结）
    │
    ▼
src/actors/         有状态对象：auth / tasks
src/history/        历史存储、分析、投影、响应缓存
src/events/         赛事来源、解析、筛选、补查队列、刷新策略
src/query/          查询参数、查询引擎、缓存记录
src/adapters/       外部 I/O：dashen / review
src/services/       纯计算：data / matches / analysis / chart / geometry
src/lib/、src/http/ 加密、快照签名、Blob、HTTP 响应
```

依赖规则：

- `services/` 不读 `fetch`、storage、Cookie、DOM，只依赖纯数据和 `lib/errors`。
- `history/`、`events/`、`query/` 可以依赖 `services/`、`lib/`、`adapters/`，不构造 HTTP 响应。
- `api/` 只做传输层翻译、方法/参数校验和响应映射；缓存键、revision 与预热由 `history/` 提供，`api/history.mjs` 只组合调用。
- `actors/` 只拥有持久状态和生命周期，不做路由匹配。
- `adapters/` 只做外部系统协议转换，不做业务决策。
- `web/` 只依赖浏览器 API、`src/shared` 和纯 `src/services`；不引入 Node 内置模块。
- `src/shared/` 与 `public/` 只由构建生成，不手改。

### 3.2 来源矩阵

| 领域 | 唯一权威 | 其他位置的角色 |
|---|---|---|
| 云端算法 | `source/core.js`、`benchmarks.js`、`rating-rules.js`、`resource-rating.js`、`performance.js`、`data/`、`ai_review.py`、`AI锐评-游戏常识.md` | `src/shared/` 只生成；`local/` 独立版本 |
| 图表渲染 | `source/chart.js` | `src/shared/chart.mjs` 生成；浏览器和后端共用，无构建期替换；`local/chart.js` 独立 |
| 云端网页基础 | `web/base/`（`app.js`、`style.css`、`data.js`）+ `web/app/` 模块 + `web/pages/strength.html` | `source/` 只保留算法与媒体；`public/` 只生成；`local/` 独立 |
| 云端网页增量 | `web/` | `public/` 只生成 |
| 历史存储 | `src/history/cloud-history.mjs` + v2 迁移/回退测试 | 只允许移动文件，不允许改格式 |
| 旧接口行为 | `src/http/legacy.mjs` + 黄金测试 | 只翻译，不复制 v1 业务规则 |

Phase 3 已完成来源拆分：基础 UI 移到 `web/base/`，增量逻辑拆到 `web/app/`，页面模板归 `web/pages/`；`sync-local.mjs` 只同步算法、数据和提示词。图表由 `source/chart.js` 与 `local/chart.js` 各自维护。

## 4. 实施阶段

每个阶段独立可回滚。阶段内先加测试，再改行为；测试与行为改动不放在同一个提交。重构期间不直接推 `main`，避免触发服务器自动发布。

### Phase 0：基线与护栏（不改生产代码）

- 以当前 `a1580f7` 为基线，实测并记录：`npm test`、`npm run build`、`npm run server:build`、`npm run web:package`、`npm run check`。
- 记录 `public/static/*` 文件清单、启动预算、渲染 SVG 摘要、Bot capture 摘要。
- 为 v1 与旧 `/api/*` 每个路由建立固定夹具的黄金响应测试。
- 为历史分析的 `slim` / 完整视图、响应缓存命中/未命中、revision 冲突建立黄金测试。
- 为历史存储 v2 建立合成数据夹具：legacy → v2 迁移、并发 push、容量拒绝、失败回滚、`history-storage-rollback.mjs` dry-run/恢复/再升级。
- 为旧任务状态（`policyVersion` 1/2、`active:*`、`awaiting-cache`、旧 `dedupe:*`）建立恢复夹具。
- 为赛事刷新窗口、补查队列和提醒调度建立固定时钟测试。
- 为图表建立 SVG 黄金测试，覆盖 Bot 固定十场、历史窗口、统计范围切换。
- 建立 `test/architecture.test.mjs`，先固定当前依赖图，随阶段收紧。
- 建立 `test/helpers/`：统一 fake storage、env、clock、fixture 构造。

验收：现有测试全绿；黄金夹具来自当前实现；不修改任何生产源码。历史 v2 迁移、回退、旧任务结算和 Bot 十场已有测试覆盖，Phase 0 先盘点缺口，不重复重建全部护栏。

### Phase 0.5：同步止损（已完成）

- 无参数只报告状态，不写入；写入必须 `--apply --only=<file>`（单文件）。
- 只同步算法、数据和提示词；网页基底和图表不再参与同步。
- 写入前先预检；存在缺失、未提交改动或未知目标时中止，不部分写入。
- 图表不再同步：`source/chart.js` 为云端权威源，`local/chart.js` 独立维护；构建补丁已随 Phase 3 移除，不再需要漂移测试。
- 验收由 `test/sync-local.test.mjs` 覆盖写入边界，`test/source-layout.test.mjs` 覆盖来源归属。

### Phase 1：结构与入口（工作树已完成）

前置条件：Phase 0.5 已让同步默认不覆盖云端差异。

完成情况：

- `src/` 已按领域分层：`api/`、`actors/`、`history/`、`events/`、`query/`、`adapters/`、`lib/`、`http/`、`services/`；`src/application/` 已移除。
- `src/security.mjs` 改为兼容 barrel，实现拆到 `src/lib/crypto.mjs`、`secrets.mjs`、`snapshots.mjs`、`blobs.mjs` 和 `src/http/response.mjs`；所有既有导入路径和 `Fault` 身份保持不变。
- `src/api/v1.mjs` 改为有序路由描述符，历史分析分支移到 `src/api/history.mjs`，`analysisResponseCache` 仍在 `v1.mjs` 再导出。
- 旧 `/api/*` 整块移到 `src/api/legacy.mjs`，`worker.mjs` 只做分派。
- `tasks.handle()` 与 `auth.handle()` 改为路由映射加小处理器；任务创建、额度、去重与兼容策略未合并，留待 Phase 2。
- 验证：303 项测试、四个原生运行时检查、`npm run build`、`npm run server:build` 通过。

以下为原计划清单，保留作为范围记录：

- 按 3.1 建立 `http/`、`actors/`、`history/`、`events/`、`query/`、`adapters/`、`lib/` 目录，先移动文件并更新 import。
- 拆分 `security.mjs` 为 `lib/crypto`、`lib/snapshots`、`lib/blobs`、`http/response`、`http/errors`；保留短期 barrel。
- `src/api/v1.mjs` 从 if 链改为路由表；把历史分析分支整体移入 `src/history/handler.mjs`，HTTP 层只做鉴权、参数和响应。
- 把 `worker.mjs` 的旧 `/api/*` 块移入 `src/http/legacy.mjs`，文件头写明“行为冻结，只做翻译”。
- `src/tasks.mjs` 的 `handle()` 改为 `handlers` 映射；`src/auth.mjs` 同样处理。只移动代码，不改条件。
- `src/application/history-cache.mjs` 归入 `src/history/cache.mjs`（实际按领域放置，而不是 `lib/`）；`history-response.mjs` 归入 `src/history/response.mjs`，缓存键、预热和容量语义不变。
- `server/analysis-encoding.mjs` 仍留在 `server/`；压缩协商目前只有一处调用，未再移动。
- `web/` 的三个懒加载器已合并为 `web/lazy-loader.js`（Phase 2）。
- `src/shared` 的全局读取已集中在 `services/runtime.mjs` 和 `api/chart.mjs` 的图表构造处；没有其他模块直接读 `globalThis.QS*`。
- **来源拆分已在 Phase 3 完成**：`web/base/`、`web/app/`、`web/pages/` 已接管网页；`source/` 只保留算法与媒体。本阶段不再搬运这些文件。
- 后续路径读取调整落在 `scripts/build-web.mjs`；`scripts/build.mjs` 保持薄入口。

验收：黄金响应逐字节一致；完整测试、构建、打包通过；依赖方向测试通过；`sync-local` 不再触碰网页文件。

### Phase 2：去重与收敛（部分完成）

已完成：

- 三个懒加载器合并为 `web/lazy-loader.js`，由构建注入目标 URL；extras、手机布局和提醒的触发条件不变。
- 四个原生运行时检查合并为 `scripts/runtime-check-suites.mjs`，`npm test` 只调用一个入口。
- 后端测试的内存存储合并为 `test/helpers/storage.mjs`；`cloud-history` 因容量断言保留局部子类。

仍待完成（保留策略，不改变行为）：

- 统一任务创建与额度结算入口，合并 `createUnified` 与旧 `/query` 分支。
- 按域整理测试目录、诊断脚本和发布脚本；不改变 `npm test` 的发现规则。

以下为原计划清单：

- 统一任务创建：把 `createUnified` 与旧 `/query` 分支收敛为一个策略驱动的 `createJob`，显式参数为 `api`、`legacy`、`policyVersion`。
- 统一账号/赛事路由翻译：v1 与旧 `/api/*` 共享同一 application 函数；语义不同的地方集中记录在一张对照表。
- 统一额度结算、退款、过期清理的入口；保留旧任务记录字段。
- 历史分析：把 revision 冲突、catalog 查询、缓存键、预热策略集中到 `history/`，`api/v1.mjs` 不再直接持有 `analysisResponseCache`。
- 赛事：把 `events*.mjs` 归入 `events/`，`EventCenter` 只保留生命周期和存储边界；刷新间隔继续使用 `events-freshness.mjs`。
- 合并运行时检查入口为 `scripts/runtime-check-suites.mjs`（已完成）。
- 合并测试夹具为 `test/helpers/storage.mjs`（已完成）；按域整理测试目录仍待定，不改变测试发现规则。
- 诊断脚本归类到 `scripts/diagnostics/`；发布脚本归类到 `scripts/release/`；只在确认无引用后删除。
- `deploy/split-release.mjs` 标记为历史工具；在 `tests/build-boundaries.test.mjs` 迁移完成前不删除。

验收：黄金测试全绿；历史 v2 迁移/回退夹具全绿；任务/额度/历史兼容夹具全绿；脚本入口数量下降且 `package.json` 契约不变。

### Phase 3：移除构建期源码手术（工作树已完成）

Phase 3 已在当前工作树单独完成，不再依赖 Phase 1/2 的目录收敛。

- 3A 图表统一（完成）：`source/chart.js` 是浏览器与后端共用的图表权威源，支持可选 `windowOffset`、`windowSize`、`columnOffset`、`plotScale`、`histogram` 与按需加载的地图素材。默认参数保持 API/Bot 原有输出；构建不做图表替换。
- 3B 网页基底归位（完成）：`web/base/app.js` 是共享云端基础 UI 定义；`web/app/timeline.js`、`export.js`、`query.js`、`boot.js` 是显式串联模块，由 `boot.js` 接线。`build-api-capture.mjs` 从 `web/base/data.js` 读取数据定义，并按现有函数边界截取玩家渲染器。构建不再对应用源码做 `indexOf`/`slice`/`replace`。
- 3C 页面组装（完成）：页面模板为 `web/pages/strength.html`，使用 `{{HEAD_ASSETS}}`、`{{SITE_MARK}}`、`{{CHANGELOG}}`、`{{API_KEY}}` 占位符。组装只做占位符替换，不改写页面结构。
- 3D 构建管线（完成）：`scripts/build.mjs` 只编排后端与网页，`scripts/build-web.mjs` 组装网页；`scripts/build-patch.mjs` 及其测试已删除。后端构建仍在 `scripts/build-backend.mjs`。

验收状态：

- `scripts/build.mjs` 不再对 `app.js` / `chart.js` 做 `indexOf` 或整段 `replace`；`test/source-layout.test.mjs` 锁定入口与来源。
- 功能清单、页面 DOM id/class、脚本顺序和懒加载边界保持不变；启动预算与 Bot capture 仍需在合入前复核。
- `local/` 独立启动仍可用；`sync-local` 不再覆盖网页 UI 或图表。
- 本阶段改动仅存在于工作树，未提交、未推送、未部署，也未做生产验收。

### Phase 4：可读性与长期护栏（部分完成）

已完成：

- 更新 `AGENTS.md`、`README.md`、`SERVICES.md`、`docs/unified-backend.md`：写入来源矩阵、目录职责、构建输入、历史 v2 回退和发布边界。
- 在 `scripts/build-web.mjs`、`web/app/` 模块和 `source/chart.js` 的边界处保留必要说明；没有为每个函数补注释。
- `scripts/build-web.mjs` 构建前清理 `public/assets`、`public/static`、`public/media`、`public/tools`，避免历史哈希文件累积；`test/source-layout.test.mjs` 锁定来源与构建入口。

暂缓：

- 对作者维护的云端源码统一格式（2 空格、单语句一行、printWidth 100）；排除 `src/shared/`、`public/` 和生成物。全量格式化应单独分支、单独提交，避免掩盖逻辑改动。
- `source/`、`local/` 是否格式化单独决定；它们与上游算法/本机版同步，格式化会增加同步冲突。
- 增加 `.git-blame-ignore-revs`，避免格式化提交污染 blame。
- 格式检查和启动预算固化；现有 `npm test`、`test/source-layout.test.mjs`、打包与 dry-run 先作为门禁。

验收：完整测试、构建、打包、dry-run 通过；文档与实际目录一致；无部署动作。本次已通过 303 项测试、四个原生运行时检查、`npm run check`、`npm run server:build` 和 `npm run web:package`。

## 5. 验收指标

| 指标 | 现状 | 目标 |
|---|---|---|
| 构建期对 `app.js` / `chart.js` 的源码手术 | 0（Phase 3 已移除） | 0 |
| 云端网页基础 UI 来源 | `web/base/` + `web/app/` + `web/pages/` | 保持 |
| `sync-local` 复制的网页或图表文件 | 0；只同步算法、数据和提示词 | 保持 |
| 旧接口与 v1 的路由实现 | 两套并行 if 链 | 1 个 v1 路由表 + 1 个冻结兼容层 |
| `tasks.handle()` 分支 | 13 个内部路径集中在一个函数 | 每路径一个 handler |
| `auth.handle()` 分支 | 约 19 个路径集中在一个函数 | 每路径一个 handler |
| 安全模块职责 | 8 类混在 1 个文件 | 5 个单一职责模块 |
| HTTP 层历史策略 | `api/v1.mjs` 内约 22 行缓存/revision/投影 | 0，移入 `history/` |
| 赛事模块 | 8 个文件平铺根目录 | `events/` 一个领域目录 |
| 懒加载器 | 1 个通用 loader | 保持 |
| 运行时检查入口 | 1 个 runner + 4 个 suite | 保持 |
| 测试夹具 | 1 套 helpers（storage 共享，cloud-history 保留局部子类） | 保持 |
| 脚本数量 | 46 | 不增加；按构建/发布/诊断分层 |
| 功能回归 | 以 Phase 0 实测为基线 | 全部通过并新增黄金测试 |
| 历史存储 v2 | 迁移、回退、revision 语义 | 逐字节保持；仅允许移动文件 |

说明：不以总行数作为目标。格式化后行数会上升，但认知负担和耦合应下降。

## 6. 不做什么

- 不换框架、不迁 TypeScript、不重写算法、不迁数据库。
- 不改 `/api/v1` 契约、签名格式、额度语义、历史容量限制。
- 不改历史存储 v2 的 blob 格式、迁移顺序、revision 或回退脚本语义。
- 不删除旧 `/api/*`；退役是单独的产品决策。
- 不改自动发布流程；重构通过分支和 PR 隔离，不直接推 `main`。
- 不自动执行 `sync-local`，不覆盖 `source/` 或 `local/` 的未合并改动；不从 `local/` 同步 `chart.js`，两端的图表各自维护。
- 不触碰 `.private/`、`.dev.vars`、`local/.private/`、未知 `dist/` 内容。
- 不推送、不部署；上线需要单独授权。
- 不为了“精简”合并语义不同的错误码、状态或兼容分支。
- 不删除旧签名缓存，不合并 `policyVersion` 1/2 的结算策略，不扁平化历史批次。
- 不把 Node 压缩依赖引入 Worker；Cloudflare 继续使用平台压缩。
- 不为迁移盲目扩大图表公共 API；没有被当前调用者使用的缓冲参数不新增。
- 不统一提示词原文的换行或字节内容；它参与 AI 请求指纹。

## 7. 执行协议

- 每个阶段在独立分支执行；不直接推 `main`，因为推送到 `main` 会触发服务器轮询自动发布。
- 每个阶段开始前：`git status`、基线测试、记录当前提交。
- 每个子步骤：先加/调整测试，再改代码；纯移动和逻辑改动分开提交。
- 每个阶段结束：`npm test`、`npm run build`、`npm run server:build`、`npm run web:package`、`npm run check`，并对比黄金夹具。
- 推送前可用 `node scripts/verify-release.mjs` 的临时 worktree 逻辑验证目标提交；它不替代真实发布。
- 发布仍由 `node scripts/deploy-local.mjs` 执行；自动发布由服务器轮询触发。两者都需要单独上线授权。
- 提交标题：纯重构用 `refactor:`；若随发布上线，按 `AGENTS.md` 补 `Changelog:` 用户可读说明。
- 任一阶段出现无法解释的黄金差异，停止该阶段，回退到上一个通过点，先定位差异来源。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `sync-local` 覆盖云端算法或数据 | 默认预检；只同步白名单；存在未提交改动、缺失或冲突时零写入 |
| 历史 v2 迁移/回退被重构破坏 | 存储格式冻结；合成数据回退测试；只移动文件不改逻辑 |
| 自动发布把半成品推上线 | 分支隔离；不推 `main`；阶段门禁；合并前跑完整测试 |
| 旧任务/旧客户端行为漂移 | 兼容层行为冻结；黄金测试覆盖旧策略与旧存储状态 |
| 历史响应缓存语义变化 | 黄金测试覆盖命中/未命中、revision 冲突、48 MiB/32 条上限、预热 |
| 图表 SVG 细节变化 | SVG 黄金测试 + 浏览器截图对比；新参数默认不改变后端输出 |
| 网页基底或页面模板回归 | 以当前构建产物为 oracle；`source-layout` 测试锁定来源；逐项功能清单 |
| 构建产物哈希/顺序变化 | 文件清单、大小、启动预算、manifest 对比；不把哈希变化本身当作失败 |
| 格式化掩盖真实改动 | 格式化单独提交；`.git-blame-ignore-revs`；格式化前完成逻辑重构 |
| 清理死代码误删兼容路径 | 先查引用与测试，再移动；兼容模块只标记 deprecated，不直接删除 |
| Bot 抓取依赖旧路径/函数边界 | `build-api-capture.mjs` 从 `web/base/data.js` 读取数据定义，并按函数边界截取玩家渲染器；调整边界时同步更新并对比 `website.json` |
| ESM 化改变脚本作用域和手机桥接 | 保留现有全局契约；若要改，单独验证桌面/手机桥接，不与目录迁移同一批 |
| 行尾/提示词字节影响指纹 | 不做全仓库换行统一；提示词原文按字节保留 |

## 9. 需要确认的决策

1. `source/` 的定位（已定）：基础 UI 在 `web/base/`，增量模块在 `web/app/`，页面模板在 `web/pages/`；`source/` 只保留算法、数据、提示词、图表和媒体；`local/` 保持独立。
2. 图表统一（已定）：`source/chart.js` 扩展可选参数，让浏览器和后端共用一份渲染器；API/Bot 默认输出不变。
3. 格式化范围：默认只格式化作者维护的云端源码，不动 `source/` 与 `local/`；若希望全仓库统一，再单独安排同步策略。
4. 旧 `/api/*` 的退役时间：本计划只冻结和隔离，不退役；退役需要先确认所有客户端已迁移。

## 10. 交付物

- 本方案：`docs/code-simplification-plan.md`
- Phase 3 工作树实现：`scripts/build.mjs`、`scripts/build-web.mjs`、`web/base/`、`web/app/`、`web/pages/strength.html`、`source/chart.js`
- Phase 4 部分实现：来源矩阵与目录职责文档、模块边界说明、生成目录清理；全量格式化与 `.git-blame-ignore-revs` 暂缓
- Phase 0 基线报告：测试、构建、产物清单、预算、黄金夹具
- 每阶段的重构提交与验收记录
- 最终架构说明：来源矩阵、目录职责、依赖规则、历史 v2 与发布边界
