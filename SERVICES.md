# 战绩服务模块

`src/services/index.mjs` 导出 `createMatchService`、`createDataService`、`createAnalysisService` 和 `ServiceError`。模块使用 ESM；数据整理和分析计算没有网络、DOM、存储或 Cloudflare 依赖。它们返回新的数据，不修改输入。获取服务会更新传入的查询状态，但会复制初始快照、恢复数据及传入缓存。

图表服务 `createChartService({core, maps, avatar, rankArt}).render(model, {art, showArt, title})` 同样从统一入口导出，返回 SVG 字符串。`core` 提供 `esc/rank/bands/roles`，其余参数显式提供素材与地图信息，不访问 DOM 或请求网络。`source/chart.js` 是浏览器与后端共用的唯一图表权威源，同时保留网页四参数 `renderChart` 入口。默认调用保持 API/Bot 原有输出；可选 `windowOffset`、`windowSize`、`columnOffset`、`plotScale`、`histogram` 和按需加载的地图素材供网页时间轴使用，构建不再替换图表源码。`scripts/sync-local.mjs` 只同步算法、数据和提示词，`chart.js` 不在同步范围。

独立 AstrBot 插件、配置与部署说明见 [插件 README](plugins/astrbot_plugin_owqs/README.md)。执行 `npm run plugin:build` 输出带算法、图表和素材的独立 ZIP；插件不依赖网站账户或 Cloudflare。

## 使用已有数据计算

先执行 `npm run build`。Worker 和仓库内的 Node 脚本可直接使用运行时适配器；不需要启动网站，也不会请求大神或 AI：

```js
import {analysisService, dataService} from './src/services/runtime.mjs';

const snapshot = {battletag: 'Example#100', matches: []};
const normalized = dataService.normalize(snapshot);
const model = analysisService.analyzeBatch(snapshot, {
  side: 'all', strategy: 'legacy', estimate: true
});
const botResult = analysisService.analyzeResult(snapshot, {
  statisticsRange: '5'
});
```

`analyzeBatch` 接收单次快照，最多 50 场；返回完整算法模型，包括 `matches`、`summary`、`confidence`、`personalPrediction`。`analyzeResult` 保持 Bot 响应结构，展示最近 10 场，统计范围支持 `all/5/10/20`。默认 `side=all`、`strategy=legacy`、`estimate=true`。

网页通过统一 `/api/v1` 获取服务端分析结果。`web/services.js` 仅暴露 `OWQS_SERVICES.data` 和 `OWQS_SERVICES.historyGeometry`，保留数据规范化与展示几何辅助，不暴露浏览器评分服务。`runtime.mjs` 是 Worker/Node 适配器，不应打入浏览器。算法、数据、提示词、图表和媒体正文来自 `source/`；网页基础定义在 `web/base/`，云端增量模块在 `web/app/`，页面模板在 `web/pages/`；`src/shared/` 是构建产物，不要手改或自动同步 `local/`。多端契约与独立构建见 [统一后端说明](docs/unified-backend.md)。

其他运行环境可以从统一入口导入工厂，将 `core`、`performance`、`heroes`、`benchmarks` 显式传入 `createAnalysisService`。`createDataService({normalizeSnapshot: core.normalize})` 绑定分析清洗规则；仅使用上游转换或历史索引时可省略转换器。

## 整理与历史分析

整理服务提供 `rankRows`、`matchList`、`player`、`matchDetail`、`projectBattle`、`mergeMatches`、`indexHistory`、`mergeArchive` 和 `normalize`。

- 上游转换输出不包含 `customerToken`；缺失和非法战斗指标仍为 `null`。玩家匿名身份由获取服务的外部适配器提供。
- `mergeMatches(previous, incoming, limit=50)` 按对局 ID 合并，后者覆盖前者，按时间倒序保留指定数量。
- `indexHistory(batches, {previous=[], limit=500, compareIds})` 只生成索引；重复对局按查询时间、批次 ID 决胜。默认按字符串比较 ID，浏览器适配保留原有同时间排序规则。
- `mergeArchive(previous, envelope, batchId, scope)` 返回浏览器归档结构，保留完整原始签名包；它不负责验签，调用前必须检查用户、服务器和赛季归属。
- `normalize` 仅生成分析视图。清洗结果不能替换原始签名快照、缓存记录或归档正文。

```js
const history = analysisService.analyzeHistory(archive, options);
const selected = history.matches.slice(-10);
const statistics = analysisService.summarize(history.raw, selected, options, {
  records: history.personalRecords,
  excluded: history.personalExcluded
});
```

`archive` 使用现有 `{tag, batches, matches}` 结构；`batches` 映射批次 ID 到完整签名包，`matches` 的每条索引包含 `mid` 和 `batchId`。`analyzeHistory` 分别分析每个原始批次，再按索引选取对局，不把最多 500 场历史合成一份输入重新估算。汇总时传入返回的个人预测记录，保留原批次证据。统计范围、图表窗口及地图素材属于调用端的展示逻辑。

## 战绩获取与平台边界

现有 `src/query/query.mjs` 和 `src/query/engine.mjs` 保留原导出和调用签名。统一后端负责鉴权、额度、缓存验签、存储、告警调度和最终归档；腾讯云通过 Node/SQLite 运行时承载，Cloudflare 保留 Worker/Durable Objects 适配，两者不是自动同步的数据副本。

```js
import {createMatchService} from './src/services/index.mjs';

const matches = createMatchService({
  provider,           // async (context, path, params, body) => 解包后的大神响应
  pick,               // (player, strategy) => 段位选取结果，可用 analysisService.pick
  playerIdentity,     // async (context, customerToken) => 不透明玩家身份
  digest, canonical, // 摘要与稳定 JSON 序列化，保持现有缓存指纹算法
  createId,           // 缓存请求 ID
  // now、sleep 可选，用于控制时间与请求间隔
});
const state = matches.createQuery('Example#100', 10, {matches: []}, [], {
  supplementOtherMatches: false
});
await matches.runQuery(state, context, {
  budgetMs: 8000,
  checkpoint: async current => savePrivately(matches.queryCheckpoint(current))
});
const restored = matches.restoreQuery(savedCheckpoint, originalPrior);
```

`context` 沿用大神请求配置：`DASHEN_SERVER/DASHEN_DTS/DASHEN_ROLE_ID/DASHEN_TOKEN`，身份适配器可额外使用签名配置。外部 provider 应保持现有错误状态码，以维持暂停、重试和软失败规则。`runQuery` 返回进度文案；完成后 `state.phase === 'done'`，结果在 `state.result`。遇到缓存请求、时间预算用尽或取消条件时会返回，由外层继续调度。

`queryCheckpoint/restoreQuery` 保持现有私有持久化格式，检查点须与原 `prior` 一起保存；`ingestCache` 只接受外层已经验签的缓存。检查点和 `accountRecords` 含上游玩家 token，禁止返回给浏览器、打印或公开保存。`accountScope`、`queryProgress`、`queryStep`、`upgradeQuery` 继续提供原有能力。

## 验证

运行 `npm run build`、`npm test`、`npm run check`。新增服务测试使用匿名固定数据，对照重构前保存的 Bot、历史分析、个人预测和锐评载荷结果，并覆盖输入不可变、依赖注入、JSON 检查点恢复、500 场历史和浏览器/Worker 一致性。原查询、缓存、签名、额度、归档和原生 Worker 运行时测试继续执行。

锐评基线固定匿名载荷，指纹按当前运行时提示词验证；额外覆盖 LF 和 CRLF 两种换行。提示词原文字节参与既有指纹计算，不能把某台机器生成的完整指纹作为跨平台固定值，也不应为通过测试改动生产提示词或缓存规则。
