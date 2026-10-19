# OWQS Bot 查询 API 说明

版本：v1  
腾讯云生产环境：`https://106.55.47.68:8443`
适用对象：已获授权账户的 Bot 后端服务器。接口不开放浏览器跨域直连。

> 如果项目部署在其他域名，请把下文示例中的 `BASE_URL` 替换为实际地址。

---

## 1. 快速开始

1. 登录网站，在右上角点击 **API**，生成并复制账户 API 密钥。
2. 在 Bot 后端以 Bearer 方式调用创建查询接口。
3. 轮询任务状态，完成后读取原始对局数据和分析结果。

```bash
BASE_URL="https://106.55.47.68:8443"
OWQS_API_KEY="owqs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

curl -sS -X POST "$BASE_URL/api/v1/query" \
  -H "Authorization: Bearer $OWQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"battletag":"昵称#12345","limit":10,"mode":"fast","statisticsRange":"all"}'
```

返回：

```json
{
  "id": "64位小写十六进制任务ID",
  "state": "running",
  "status": "/api/v1/jobs/64位小写十六进制任务ID"
}
```

随后轮询：

Bot 图片回复可使用 `GET /api/v1/jobs/<任务ID>?render=svg&compact=1`。任务完成后增加 `chart`：`{version:1, format:"svg", mimeType:"image/svg+xml", width:1440, height:1100, displayed:10, statisticsRange:"10", missingAssets:0, svg:"<svg ...>"}`。素材内嵌为 data URI，可断网转 PNG；图片始终展示并统计最近最多 10 场，不改变查询范围。没有可展示对局时 `chart` 为 null；出图失败返回 `chartError`，原分析仍可用。图片与结果使用相同 Bearer 认证和账号隔离，不提供公开图片链接，也不额外扣查询额度。

`compact=1` 省略原始 `result`、`analysis.statsMatches`、玩家完整阵容及完整个人预测过程，只保留摘要、所选个人预测和逐局主要字段。`render` 仅接受 `svg`，参数非法返回 400。不带这些参数时，v1 原有返回结构保持不变。AstrBot API 插件会在 Bot 本机渲染 PNG，并默认发送图片；AI 查询工具也会直接发送图片。

```bash
curl -sS "$BASE_URL/api/v1/jobs/<任务ID>" \
  -H "Authorization: Bearer $OWQS_API_KEY"
```

---

## 2. 认证与安全

### 2.1 Bearer 密钥

所有 `/api/v1/*` 请求必须携带：

```http
Authorization: Bearer owqs_<64位小写十六进制>
```

- 每个账户只有一个 API 密钥。
- 密钥属于账户，不区分具体 Bot 实例。
- 账户必须处于已授权状态；未授权或已撤销返回 `403`。
- 密钥无效、缺失或重新生成后旧密钥返回 `401`。
- 服务端只保存密钥摘要用于鉴权，密文使用 `API_KEY_ENCRYPTION_KEY` 加密保存。

### 2.2 密钥管理

- 网页右上角 **API** 打开密钥面板。
- 密钥默认隐藏，可查看、复制、重新生成。
- 重新生成后旧密钥立即失效。
- 密钥只显示给当前登录账户；请像密码一样保管，不要写入前端代码、公开仓库或日志。
- 泄露后立即重新生成，并检查账户查询历史是否有异常任务。

### 2.3 浏览器限制

接口不返回 CORS 头，`OPTIONS` 返回 `405`。浏览器页面不能直接调用，必须由自己的后端服务器代理。

---

## 3. 通用约定

### 3.1 请求格式

- 创建查询必须使用 `Content-Type: application/json`，否则返回 `415`。
- 请求体上限约 3 MB，超过返回 `413`。
- 所有响应均为 JSON，`Cache-Control: no-store`。
- 任务 ID 为 64 位小写十六进制字符串。

### 3.2 错误格式

```json
{ "error": "中文错误说明" }
```

HTTP 状态码：

| 状态码 | 场景 |
|---|---|
| `400` | 参数格式或取值错误 |
| `401` | 缺少、无效或已失效的 API 密钥 |
| `403` | 账号未授权或授权已撤销 |
| `404` | 任务不存在、已过期、不属于当前账号，或路径不存在 |
| `405` | 请求方法错误，或浏览器 `OPTIONS` 预检 |
| `413` | 请求体过大 |
| `415` | `Content-Type` 不是 `application/json` |
| `429` | 未完成任务达到 5 个，或今日查询额度用完 |
| `500` / `503` | 服务异常、上游凭证或加密配置不可用 |

`429` 的具体原因见 `error` 文本。

---

## 4. 创建查询

```http
POST /api/v1/query
Authorization: Bearer owqs_...
Content-Type: application/json
```

### 4.1 请求字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `battletag` | string | 是 | — | 完整战网昵称，格式 `昵称#编号`，最长 80 字符。也接受 `playerId` 或 `player` 作为别名。 |
| `limit` | integer | 否 | `10` | 搜索场次，只能是 `5`、`10`、`20`。只决定搜索范围，不决定图表展示范围。 |
| `mode` | string | 否 | `fast` | `fast` 快查询；`slow` 慢查询，按缺口补充近期对局。 |
| `supplementOtherMatches` | boolean | 否 | `false` | `true` 等价于 `mode=slow`，`false` 等价于 `mode=fast`。 |
| `fast` | boolean | 否 | `true` | `true` 等价于 `mode=fast`，`false` 等价于 `mode=slow`。 |
| `statisticsRange` | string | 否 | `all` | 分析统计范围：`all`、`5`、`10`、`20`。只影响分析，不影响查询范围。 |
| `side` | string | 否 | `all` | 分析玩家范围：`all` 双方、`T` 我方、`E` 对方。 |
| `strategy` | string | 否 | `legacy` | 段位选取方式：`legacy` 职责优先并跨职责补充、`role` 仅本局职责、`highest` 最高已知职责。 |
| `estimate` | boolean | 否 | `true` | 缺失或段位稀疏时是否显示融合估值。 |

快/慢参数同时出现时必须一致，否则返回 `400`。例如：

- `mode=slow` + `supplementOtherMatches=true`：合法。
- `mode=fast` + `supplementOtherMatches=true`：冲突，返回 `400`。
- 只传 `supplementOtherMatches` 或 `fast` 时，按该布尔值决定快/慢。

### 4.2 请求示例

快查询，最近 10 场，统计全部：

```json
{
  "battletag": "昵称#12345",
  "limit": 10,
  "mode": "fast",
  "statisticsRange": "all"
}
```

慢查询，最近 20 场，只统计最近 5 场，只看我方：

```json
{
  "battletag": "昵称#12345",
  "limit": 20,
  "mode": "slow",
  "statisticsRange": "5",
  "side": "T",
  "strategy": "role",
  "estimate": false
}
```

### 4.3 成功响应

```json
{
  "id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "state": "running",
  "status": "/api/v1/jobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

创建成功即预留 1 次查询额度；任务异步执行。

### 4.4 并发与额度

- 每个 API 密钥最多同时保留 **5 个未完成 API 任务**。
- 第 6 个创建请求返回 `429`。
- 任务完成、失败或取消后释放名额。
- 创建时检查并预留今日查询额度；额度不足返回 `429`。
- 网页端查询与 Bot API 共用账户的每日查询额度。

---

## 5. 查询任务状态与结果

```http
GET /api/v1/jobs/{id}
Authorization: Bearer owqs_...
```

### 5.1 响应字段

| 字段 | 说明 |
|---|---|
| `id` | 任务 ID |
| `state` | 任务状态，见下表 |
| `message` | 当前状态的中文说明 |
| `progress` | 进度对象；尚未开始时可能为 `null` |
| `createdAt` | 创建时间，Unix 毫秒 |
| `finishedAt` | 进入终态的时间，Unix 毫秒；未结束为 `null` |
| `options` | 本次查询规范化后的参数 |
| `quota` | `reserved`、`charged` 或 `released` |
| `archiveWarning` | 历史归档失败时的提示；成功为 `null` |
| `result` | 仅 `done` 时返回，原始对局数据 |
| `analysis` | 仅 `done` 时返回，网站计算的分析结果 |
| `analysisError` | 分析生成失败时的提示；正常不出现 |

### 5.2 状态

| state | 含义 | 是否终态 | 额度 |
|---|---|---|---|
| `running` | 执行中或排队中 | 否 | 保留 |
| `paused` | 上游限流或临时错误，后台自动重试 | 否 | 保留 |
| `done` | 查询成功完成 | 是 | 已扣 1 次 |
| `failed` | 查询失败 | 是 | 已释放 |
| `cancelled` | 查询已取消 | 是 | 已释放 |

`awaiting-cache` 是网页端缓存交接的内部状态；Bot API 正常不会进入该状态。

终态任务和结果约保留 **1 小时**；运行中任务最长约 **1 小时**。过期后查询返回 `404`，请及时保存结果。

### 5.3 进度对象

```json
{
  "phase": "details",
  "phaseLabel": "读取新增对局",
  "completed": 4,
  "total": 10,
  "requests": 18,
  "cacheHits": 22,
  "deduplicatedRequests": 3
}
```

常见 `phase`：`account`、`list`、`details`、`ranks`、`history-start`、`history-ranks`、`done`。

### 5.4 完成响应示例

以下为结构示例，数组内容已省略：

```json
{
  "id": "…",
  "state": "done",
  "message": "查询完成",
  "progress": {
    "phase": "done",
    "phaseLabel": "查询完成",
    "completed": 10,
    "total": 10,
    "requests": 28,
    "cacheHits": 14,
    "deduplicatedRequests": 0
  },
  "createdAt": 1760700000000,
  "finishedAt": 1760700035000,
  "options": {
    "battletag": "昵称#12345",
    "limit": 10,
    "mode": "fast",
    "supplementOtherMatches": false,
    "statisticsRange": "all",
    "side": "all",
    "strategy": "legacy",
    "estimate": true
  },
  "quota": "charged",
  "archiveWarning": null,
  "result": {
    "battletag": "昵称#12345",
    "queriedAt": "2026-10-17T13:00:00.000Z",
    "source": "网易大神 · 云端增量查询",
    "matches": [],
    "recentHistory": [],
    "queryCache": {},
    "syncStatus": {},
    "historyStatus": {}
  },
  "analysis": {
    "version": "2.6",
    "displayLimit": 10,
    "statisticsRange": "all",
    "statisticsLabel": "全部历史 · 10 场",
    "windowOffset": 0,
    "matches": [],
    "statsMatches": [],
    "summary": {},
    "confidence": {},
    "personalPrediction": {}
  }
}
```

### 5.5 `result` 原始数据

`result` 是本次查询的原始结果，主要字段：

| 字段 | 说明 |
|---|---|
| `battletag` | 查询账号 |
| `queriedAt` | 查询时间 ISO 字符串 |
| `source` | 数据来源说明 |
| `matches` | 主查询对局，最多 50 场；列表范围由 `limit` 控制，历史合并可能带出更多 |
| `recentHistory` | 补充的近期参考对局 |
| `queryCache` | 服务端/浏览器缓存材料，结构可能变化，不建议依赖 |
| `syncStatus` | 本次查询的请求与缓存统计 |
| `historyStatus` | 近期参考采样统计 |
| `queryIndexMatches` | 最近对局索引，最多 50 条 |

单场对局常用字段：

| 字段 | 说明 |
|---|---|
| `mid` | 对局 ID |
| `t` | 对局开始时间，Unix 毫秒 |
| `mapGuid` | 地图 ID |
| `ret` | 胜负标记，`1` 胜、`-1` 负、`0` 未知 |
| `duration` | 时长，秒 |
| `teamScore` / `opponentScore` | 比分 |
| `hasGameData` | 是否有对局详情 |
| `players` | 玩家数组 |

玩家字段：

| 字段 | 说明 |
|---|---|
| `name` | 玩家昵称 |
| `side` | `T` 我方、`E` 对方 |
| `hero` | 英雄 GUID |
| `playerKey` | 匿名玩家标识 |
| `stats` | 击杀、助攻、死亡、伤害、治疗、抵挡、受治疗、承伤等 |
| `res` | 竞技段位快照；可能包含 `rows`、`previousRows`、`rankQueriedAt`、`error` |

`result` 不包含大神 customer token 等查询凭证。

### 5.6 `analysis` 分析结果

`analysis` 与网站图表使用同一套分析逻辑，主要字段：

| 字段 | 说明 |
|---|---|
| `version` | 分析算法版本，例如 `2.6` |
| `matches` | 图表窗口，**固定最多 10 场**；不足 10 场时返回实际数量 |
| `statsMatches` | 按 `statisticsRange` 选出的统计样本 |
| `windowOffset` | `matches` 在完整分析集合中的起始下标 |
| `displayLimit` | 固定为 `10` |
| `statisticsRange` | `all`、`5`、`10` 或 `20` |
| `statisticsLabel` | 统计范围中文说明 |
| `summary` | 场次强度、可查段位、估算场次、可信度等汇总 |
| `confidence` | 对局证据评分，不是命中率 |
| `personalPrediction` | 个人段位预测、逐场记录与排除原因 |
| `options` | 分析使用的 `side`、`strategy`、`estimate` 等 |

`summary` 常用字段：

```json
{
  "total": 100,
  "known": 92,
  "mean": 3150.2,
  "observedMean": 3120.5,
  "min": 2800,
  "max": 3500,
  "playerMean": 3130.4,
  "estimated": 3,
  "unanchored": 0,
  "auxiliary": 12,
  "previous": 0,
  "errors": 0,
  "confidencePercent": 78
}
```

说明：

- `matches` 是图表可见窗口，固定最多 10 场。
- `statsMatches` 是统计口径，可能多于或少于 10 场。
- `estimate=true` 时，缺失段位会使用融合估值；这是规则参考，不是真实竞技段位或 MMR。
- `confidence` 是对局证据评分，不是预测命中率。
- `personalPrediction` 只使用查询账号本人的有效对局，并排除样本不足、替补、短局等情况。

### 5.7 缓存与历史

- API 会自动读取该账户已归档历史作为查询先验，重复查询可复用对局、段位和近期参考。
- `result.syncStatus.cachedOnly=true` 表示本次没有新增对局详情或段位请求，但成功任务仍扣 1 次额度。
- 成功查询会自动写入密钥所属账户的历史记录，与网页端历史共用。
- `archiveWarning` 非空表示结果已生成但历史归档失败；结果仍可在任务有效期内读取。

---

## 6. 取消任务

```http
POST /api/v1/jobs/{id}/cancel
Authorization: Bearer owqs_...
```

成功返回：

```json
{ "ok": true }
```

说明：

- 取消是异步生效；正在执行的请求可能先完成。
- 进入终态后释放预留额度，不扣查询次数。
- 已完成的 `done` 任务不会被改判为取消，也不退额度。
- 其他账户的任务返回 `404`。

---

## 7. 额度、并发与重试

### 7.1 额度

- 每个成功完成的查询任务扣 **1 次**查询额度。
- 与 `limit`、实际请求数、缓存命中数无关。
- 纯缓存结果同样扣 1 次。
- 失败、取消、最终超时不扣。
- 暂停任务保留预留额度，恢复完成后正常扣 1 次；进入失败/取消终态时释放。
- 默认每日 10 次，管理员可调整；北京时间零点重置。
- 网页端查询和 Bot API 共用同一账户额度。
- AI 锐评是独立功能，使用独立 AI 额度，不计入查询的 1 次。

### 7.2 并发

- 每个 API 密钥最多 5 个未完成 API 任务。
- 超过上限创建返回 `429`。
- 终态任务不占名额。
- 取消或失败后可以立即创建新任务。

### 7.3 暂停与自动重试

- 上游限流或临时错误会把任务置为 `paused`。
- 暂停期间保留额度，后台自动重试。
- 客户端继续轮询即可，不需要重新创建任务。
- 任务最终失败、取消或超时后释放额度。

### 7.4 轮询建议

- 创建后每 1–2 秒轮询一次。
- 遇到 `paused` 可降低到 5 秒一次。
- `state` 为 `done`、`failed` 或 `cancelled` 时停止轮询。
- 结果保留约 1 小时，请及时保存。

---

## 8. 账户密钥管理（网页端）

本节接口使用登录会话和 CSRF，不是 Bearer 密钥，仅供网站账户页使用。Bot 后端不应调用。

### 8.1 查询密钥状态

```http
GET /api/auth/session
Cookie: qs_session=...
```

响应中的：

```json
{
  "user": {
    "apiKey": {
      "exists": true,
      "createdAt": "2026-10-17T13:00:00.000Z",
      "updatedAt": "2026-10-17T13:00:00.000Z"
    }
  }
}
```

### 8.2 查看密钥

```http
POST /api/auth/api-key
Cookie: qs_session=...
Origin: https://站点域名
Content-Type: application/json
X-CSRF-Token: <session csrf>

{"action":"reveal"}
```

返回：

```json
{
  "key": "owqs_...",
  "createdAt": "2026-10-17T13:00:00.000Z"
}
```

尚未创建时返回 `404`。

### 8.3 重新生成密钥

```http
POST /api/auth/api-key
Cookie: qs_session=...
Origin: https://站点域名
Content-Type: application/json
X-CSRF-Token: <session csrf>

{"action":"regenerate"}
```

返回新的 `key` 和 `createdAt`。旧密钥立即失效；已在运行的任务继续使用账户身份完成，不受影响。

---

## 9. 代码示例

### 9.1 curl 创建并轮询

```bash
BASE_URL="https://quick-strength-friends.wenlangjian79.workers.dev"
OWQS_API_KEY="owqs_..."

JOB_ID=$(curl -sS -X POST "$BASE_URL/api/v1/query" \
  -H "Authorization: Bearer $OWQS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"battletag":"昵称#12345","limit":10,"mode":"fast"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")

while true; do
  RESPONSE=$(curl -sS "$BASE_URL/api/v1/jobs/$JOB_ID" \
    -H "Authorization: Bearer $OWQS_API_KEY")
  STATE=$(printf '%s' "$RESPONSE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).state))")
  echo "state=$STATE"
  case "$STATE" in
    done|failed|cancelled) printf '%s\n' "$RESPONSE" > "job-$JOB_ID.json"; break ;;
  esac
  sleep 2
done
```

### 9.2 Node.js

```js
const BASE = 'https://quick-strength-friends.wenlangjian79.workers.dev';
const KEY = process.env.OWQS_API_KEY;

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
  return value;
}

async function query(battletag) {
  const job = await request('/api/v1/query', {
    method: 'POST',
    body: JSON.stringify({
      battletag,
      limit: 10,
      mode: 'fast',
      statisticsRange: 'all'
    })
  });

  for (;;) {
    const status = await request(`/api/v1/jobs/${job.id}`);
    if (['done', 'failed', 'cancelled'].includes(status.state)) return status;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

const result = await query('昵称#12345');
console.log(result.state, result.analysis?.summary);
```

---

## 10. 常见问题

### 浏览器直接调用报 CORS 错误？

接口不开放跨域。请由自己的后端服务器调用，再把结果返回给浏览器。

### 返回 401？

- 没有 `Authorization: Bearer ...`。
- 密钥格式不是 `owqs_` + 64 位小写十六进制。
- 密钥已重新生成，旧密钥失效。
- 账户登录失效不影响 API 密钥；API 密钥只按自身摘要校验。

### 返回 403？

账户未授权或授权已撤销。请联系管理员。

### 返回 429？

两种原因：

1. 当前密钥已有 5 个未完成任务。
2. 今日查询额度已用完。

错误文本会区分。

### 为什么纯缓存也扣 1 次？

额度按“成功完成的查询任务”计，不按实际请求数或缓存命中数计。

### `statisticsRange` 和 `limit` 有什么区别？

- `limit` 控制向大神查询最近 5/10/20 场，影响搜索范围。
- `statisticsRange` 只控制分析统计范围。
- 图表窗口始终固定最多 10 场。

### 任务结果能保留多久？

任务和结果约保留 1 小时；过期返回 `404`。请及时保存。

### 重新生成 API 密钥会影响正在运行的任务吗？

不会。任务按账户身份继续执行；新密钥可以读取这些任务，旧密钥立即失效。

---

## 11. 部署配置

生产环境必须配置 Worker Secret：

```bash
node scripts/wrangler.mjs secret put API_KEY_ENCRYPTION_KEY
```

说明：

- 该 Secret 只用于加密账户 API 密钥。
- 更换 Secret 后，已有密钥仍可用于鉴权，但无法再查看明文；用户可在账户页重新生成。
- 不要把密钥、`.dev.vars` 或 `.private` 目录提交或上传到静态资源。

## 单局数据与锐评

- `GET /api/v1/jobs/{queryId}/matches/{n}` 返回 `{match}`，包含单局元信息及双方脱敏凭证后的战斗数据。n 是该查询最近十场窗口从左到右的 1—10；不足十场按实际数量校验。不会重新请求上游或扣查询额度。
- `POST /api/v1/jobs/{queryId}/matches/{n}/review`，JSON `{requestId:"一次显式请求的唯一标识"}`，复用网站签名来源和 AI 额度。返回 `{id,state,status,match}`；已缓存时直接返回 `{cached:true,review,match}`。同一内容最多保留 50 份签名锐评缓存，读取有效期 30 天；不额外消耗查询额度。
- `GET /api/v1/reviews/{id}` 轮询 `{state,message,match,review,quota}`，完成后有锐评正文，不返回签名包或 AI 凭证。AI 在后台仅派发一次，失败按原有规则释放网站 AI 额度。

所有路径均需要原有 Bearer 密钥并隔离账户。无效编号返回 400，其他账户记录／过期查询返回 404，进行中冲突返回 409。Bot 只对发送者最近一次成功查询的窗口操作，重查后编号更新；首次升级须先查询。
# 赛事缓存查询

`GET /api/v1/events` 使用原有 Bearer Key 鉴权，只读取服务器每小时同步的数据，不创建战绩任务、不扣查询／AI 次数。支持 `from`、`to`（北京时间 YYYY-MM-DD）、`region`（中文或 CN/KR/JP/PAC/NA/EMEA/ASIA/GLOBAL）、`tournament` 和 `team`（大小写不敏感关键词，战队同时匹配简称）、`status=scheduled|completed|all`、`limit=1..20`（默认 10）。日期范围含首尾；赛程升序，赛果倒序，未知时间排末尾。上游先按 OWCS 页面范围筛选，再分别获取最多 50 场赛程与赛果，避免非 OWCS 比赛挤占条数。日期条件只筛已获取缓存，不向上游按日期补查，不保证所选日期的全部赛事；覆盖说明见 `coverage`。

响应包括筛选后的 `matches`、匹配总数 `total`、`limit`、`filters`、`updatedAt`、`stale`、`source` 和 `coverage`。无匹配返回空列表；没有可用服务器缓存返回 503。该接口没有刷新／同步参数，个人和 free 层级 Key 均可读取。
