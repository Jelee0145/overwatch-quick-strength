# 查询提速与上游限流：实现与验收

## 目标与已定结论

提升查询速度，同时保护所有用户共用的网易大神上游额度。用户已决定：限流器最高启动速率 **8 req/s**。

本文档原先只记录决定与边界；本轮已完成实现与本地验证。**未提交、未推送、未部署、未在生产环境做新的上游扫描**。

## 结论（confirmed-current）

- 只有一个全局预算：`src/services/scheduler.mjs` 的 `createScheduler()` 在 `server/runtime.mjs` 中为整个进程创建一次，所有用户、所有任务、所有上游请求共用。
- 启动速率硬上限 `MAX_RATE_PER_SECOND = 8`；任何配置值都会被夹到 8 以内（`ratePerSecond`、`upstreamRates` 都只能向下调，不能上调）。
- 令牌桶默认 `burst = 1`：相邻启动严格按 125ms 间隔，任意 1 秒窗口内不超过 8 次启动。`burst > 1` 会让第一秒出现 9 次启动，正是扫描中触发 429 的速率，因此不作为默认值。
- 在途并发与启动速率是两个参数：默认 `concurrency = 6`，只用于兜住慢端点（详情 p50 约 82–90ms 时 8 req/s 通常只需 1 个在途请求）。可用 `upstreamRates.concurrency` 下调。
- 优先级：账号搜索 / 对局列表 / 主对局详情为 `high`；主段位为 `normal`；近期参考全部为 `low`。同级按到达顺序 FIFO；等待超过 `maxAgeMs`（默认 2.5s）提升一级，最多提升到 `high`，因此低优先级不会被饿死。
- 取消：等待中的请求带 `AbortSignal`，取消后立刻离开队列且不会占用并发额度；`AbortSignal.timeout(25000)` 仍由适配器提供。
- 429：适配器（HTTP 状态或响应体 code）在同一次失败里调用 `env.UPSTREAM_SCHEDULER.coolDown()`，整个共享调度暂停 3 秒或 `Retry-After` 指定时长（上限 60s），并清空令牌，恢复后不会以突发方式重试。
- 任务层：429 仍然暂停任务，首次 30 秒，重复 429 指数退避（30s→60s→120s 上限）；502/504 为 5s→10s→……上限 120s。重复失败只影响该任务自身的并发与启动间隔（`adaptPacing`：429 后单并发、500ms 起、最多 2s），一次成功即清零。
- 每任务 `nextStartAt` 节拍已不再是常规限速手段：默认 `minIntervalMs = 0`，只有显式设置（自检、运维工具、降级）时才按任务自身间隔启动。全局调度是唯一常态限速，避免双重限速和绕过。
- Cloudflare Worker（`src/worker.mjs`）不加载 `server/`：调度器只属于单机 Node 服务，Worker 侧仍由平台子请求限制兜底。

## 权威文件

- `src/services/scheduler.mjs`：共享调度器（令牌桶 + 并发上限 + 优先级/老化 + 冷却）。
- `server/limiter.mjs`：`pacedFetch()` 把 fetcher 接到调度器；`server/runtime.mjs` 为整个进程创建一个调度器，并导出 `env.UPSTREAM_SCHEDULER`。
- `src/services/matches.mjs`：每个操作按阶段给出优先级（`PRIORITY`），并把优先级作为第 5 个参数传给 provider。
- `src/adapters/dashen.mjs`：把优先级作为 `fetcher` 的第 3 个参数传递（**不**写进 RequestInit），并在 429 时冷却全局调度。
- `src/actors/tasks.mjs`：`adaptPacing()`、`backoff()`、`rateLimitFailures`/`failures` 计数与恢复。
- 扫描工具仍为 `scripts/upstream-limit-scan.mjs`、`scripts/upstream-scan-rate.mjs`、`scripts/upstream-scan-shared.mjs`；最近一次扫描结果在 `.private/upstream-*.json`，不得提交、上传或打印。

## 本轮验证（verified，本机 Windows）

- `npm test`：366 项通过（含四个 workerd 原生运行时检查）。
- `npm run build`、`npm run check`（dry-run）通过。
- `prettier --check` 通过。
- 新增测试：`test/services/scheduler.test.mjs`（速率夹取、每秒窗口上限、突发上限、优先级/FIFO、老化防饿死、取消、冷却恢复）、`test/adapters/upstream.test.mjs`（优先级传递、429 冷却与 Retry-After、RequestInit 保持规范字段）、`test/release/standalone.test.mjs`（运行时单一调度器与限速）、`test/query/*`（阶段优先级、429 退避与恢复、取消清理）。
- 真机 fetch 冒烟（本机回环 HTTP + undici）：20 次请求全部 200，稳态间隔约 140ms（Windows 定时器粒度约 15.6ms 造成固定偏移，Linux 上应接近 125ms），实测 7.6 req/s，未超过 8 req/s。

## 未验证 / 风险

- 没有在生产出口重跑扫描；8 req/s 仍是用户选定的上限，不是已证明对所有线上混合流量无风险的速率。
- 没有部署。生产代码版本、服务健康、真实账号查询时长、429 冷却在实际流量下的表现均未验证。
- 扫描没有区分限流按 IP、凭证还是接口分桶；若按接口分桶，单一 8 req/s 全局预算会更保守（而不是更危险）。
- `plugins/astrbot_plugin_owqs/runtime.mjs` 是生成产物，本轮未重新 `npm run plugin:build`；插件进程不经过 `UPSTREAM_FETCH`，行为未变，但下次发布时应随构建刷新。
- 429 后任务在整轮查询内保持降级（单并发、500ms+ 间隔），直到该次 `runQuery` 正常返回才清零；长查询会因此变慢，这是保守取舍。

## 下一步

1. 取得上线授权后：本地提交 → 推送 → `node scripts/deploy-local.mjs`，随后观察 `owqs` 日志中的 `dashen-fetch-failed` 与 429 记录、任务暂停频率和单次查询耗时。
2. 只有在生产观察到 429 或额度告警时，才在授权范围内继续下调 `ratePerSecond`/`concurrency`；提高上限必须先做新的生产扫描。
3. 若要把优先级权重、老化时间或冷却时长调整成参数，请附带真实流量证据。

## 不要假设

- 8 req/s 在所有线上混合流量下已证明无风险。
- 9 req/s 的结果已被重复确认，或 429 的归属维度/冷却窗口已查明。
- 扫描脚本的速率、每任务并发与全局速率上限是同一个概念。
- 本文件或本轮的 366 项测试代表生产已验证，或本轮授权了提交、推送、部署。
