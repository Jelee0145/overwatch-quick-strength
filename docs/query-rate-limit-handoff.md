# 查询提速与上游限流交接

## 目标与决定

提升查询速度，同时保护所有用户共用的网易大神上游额度。用户已决定：后续限流器的最高启动速率按 **8 req/s** 设置。本交接只记录决定和实现边界；本次没有修改运行逻辑、部署或启动后续任务。

## 当前状态

- `confirmed-current`：仓库根目录 `D:/project/owqs`，分支 `main`，HEAD 与 `origin/main` 同步。
- `confirmed-current`：`server/limiter.mjs` 的 `pacedFetch()` 当前为全局共享 `intervalMs=500`、`concurrency=3`，即请求启动间隔默认 500ms，并限制同时在途请求数。
- `confirmed-current`：`src/services/matches.mjs` 的查询状态默认 `minIntervalMs=500`、`concurrency=3`；请求启动还会按 `nextStartAt` 串行节拍放行。`src/actors/tasks.mjs` 在恢复任务时会把查询降为单并发、1000ms 间隔；429 的重试暂停为 30 秒。
- `memory-derived`：2026-10-25 在生产出口进行的上游扫描记录显示，详情延迟常见 p50 约 82–90ms；8 req/s 的一次 360 请求运行没有 429；9 req/s 多次运行结果不一致，其中修正扫描器后的一次运行仍触发 429；10 req/s 两次均很早触发 429。扫描记录因此支持把最高速率定为 8 req/s。该数据本轮未重新从 `.private/` 核实，也未重新进行生产扫描。
- `memory-derived`：早期阶梯数据受扫描器追赶突发缺陷影响；修正后 9 req/s 的一次运行不能单独证明 8 req/s 对所有线上混合流量都安全。扫描最长观察窗口有限，也没有区分限流按 IP、凭证或接口分桶。
- `implemented-unverified`：Phase 0/Phase 1 扫描脚本及测试位于 `scripts/upstream-limit-scan.mjs`、`scripts/upstream-scan-rate.mjs`、`scripts/upstream-scan-shared.mjs`、`test/upstream-limit-scan.test.mjs`、`test/upstream-scan-rate.test.mjs`。这些文件在本次状态检查中为未跟踪；此前记录称 Node 全套 311 项和四项 workerd 检查通过，但本轮未重跑。生产扫描临时目录此前已清理的记录来自上一轮，本轮未重新连接主机确认。

## 当前仓库状态与改动归属

状态检查时，工作区除本交接外已有以下改动：`docs/code-simplification-plan.md` 已修改，`docs/code-simplification-handoff.md` 未跟踪；限流扫描相关三个脚本和两个测试文件未跟踪。这些既有文件不是本次编写，均应保留。本次新增文件为 `docs/query-rate-limit-handoff.md`。未提交、未推送、未部署，也未访问或输出私密扫描结果、配置或账号凭证。

## 后续实现边界

得到后续实施指示后，先重新检查分支、工作区、当前代码与生产状态，再按以下方向设计和验证：

1. 将全局请求启动控制改为明确的共享速率上限，最大值不超过 8 req/s；速率预算必须跨所有用户共享，不能按每个任务各自开放 8 req/s。
2. 限制令牌桶或等效调度器的突发量，避免短时间集中发请求；分别评估每秒速率与在途并发，不能把两者当作同一参数。88ms 左右的详情延迟意味着 8 req/s 通常可由一个在途请求承载，但其他端点延迟和线上混合流量仍需实测。
3. 按用户可见价值调度请求：账号搜索、主对局列表和详情优先；段位及历史补充请求低优先级，且不得饿死。明确 FIFO/权重、取消、失败重试、限时让出和跨任务公平性。
4. 核查 429 处理：目前任务层遇到 429 会暂停约 30 秒。若后续根据真实行为改成短退避，须用可信响应与并发场景验证，避免立即重试导致再次触限或任务风暴；一次即时恢复探测不足以确定通用冷却策略。
5. 保持取消信号、请求计数、checkpoint/重启语义和所有用户共用额度正确；确认查询内部 `minIntervalMs` 不会与全局调度器重复限速或意外绕过全局上限。
6. 评估通过集成/运行时测试证明速率硬上限、突发上限、优先级、公平性、取消及 429 恢复。只有在实现与验证完成后，才更新参数结论；此交接没有授权改代码、提交、推送或部署。

## 权威文件

- `server/limiter.mjs`：Node 服务的全局 fetch pacing。
- `src/services/matches.mjs`：查询操作队列、阶段、每任务节拍与并发。
- `src/actors/tasks.mjs`：持久任务执行、恢复降级与错误退避。
- `AGENTS.md`：仓库约束与发布边界。
- `scripts/upstream-scan-rate.mjs` 与对应测试：速率扫描工具实现；其结果文件存放在 `.private/`，不得提交、上传或打印。

## 下一位接手者先检查

先运行 `git status --short --branch`、`git log -1 --oneline` 并查看 `server/limiter.mjs`、`src/services/matches.mjs`、`src/actors/tasks.mjs` 和 `AGENTS.md`。确认扫描结果是否仍在本机私密目录、是否有生产任务正在运行，以及当前生产代码版本；不得把本文件里的历史实测或 311 项测试记录当成本轮新验证。随后再等待用户明确授权后续实现与运行验证。

## 不要假设

- 8 req/s 是所有线上混合流量下已证明无风险的速率；它是用户选定的最高上限，依据是有限时长、有限场景的扫描。
- 9 req/s 的结果已被重复、长时间确认，或 429 的归属维度/冷却窗口已查明。
- 扫描脚本的最高速率、每任务并发与全局速率上限是同一个概念。
- 生产部署与 `main` 一致，或本次交接授权了任何实现、提交、推送、部署或生产扫描。
