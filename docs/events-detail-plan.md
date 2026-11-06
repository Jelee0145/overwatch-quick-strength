# 赛事中心自有详情页方案（待确认，未实现）

> 调研日期 2026-11-06。依据：当前代码、[Liquipedia API Terms of Use](https://liquipedia.net/api-terms-of-use)、[Liquipedia API 介绍页](https://liquipedia.net/api)、Liquipedia commons 队标文件页的授权标签。

## 0. 结论先行

1. **能做到「不跳外链也能看全」，但不能做到「完全没有外链」。** 文字和数据采用 CC BY-SA 3.0 许可，必须署名 Liquipedia，并链接到原页面和许可证。方案是：所有浏览动作都在本站完成，每个详情页只保留一行小号的来源署名链接。
2. **队标自托管已经上线**（`d1e3ef2`，已在 `origin/main`）。三处 CSP 的 `img-src` 已是 `'self' data: blob:`，测试 `events-logos.test.mjs` 会防止回退。任务第 4 点里的「队标改本站缓存、CSP 去掉 liquipedia.net」在仓库里**已完成**，只剩**确认线上 1Panel 的 OpenResty 配置是否同步**，见第 6 节。
3. **发现一个合规隐患，建议先修**：队标下载间隔 `GAP = 500`（`backend/src/events/logos.mjs:7`），每轮最多 12 张，也就是约 2 次/秒。条款写的是 “Rate limit all HTTP requests to no more than 1 request per 2 seconds”，这里比上限快 4 倍。图片是否计入这条限制，条款没有写明，但按最严格的理解，应改为 ≥2000ms。
4. 详情数据**不能抓 HTML 页面**（条款原文：“Automated access to non-API endpoints (ie, generated HTML pages) is not permitted.”），只能走 API。`action=parse` 限 **1 次/30 秒**，而且与现有赛程同步共用。这是整个方案最紧的预算，所以要先用廉价的 `action=query` 做变更检测，只重新解析有改动的页面。

## 1. 现状盘点

### 1.1 现在拿了哪些数据

数据来源只有一个：`https://liquipedia.net/overwatch/api.php?action=parse`。请求的 wikitext 调用 `MatchTicker/Custom` Lua 模块，生成近期赛程和赛果（`backend/src/events/source.mjs`）。

| 字段 | 来源 | 位置 |
|---|---|---|
| 开赛时间 `startsAt` | `.timer-object[data-timestamp]` | `parser.mjs` |
| 状态（未开始/进行中/已结束） | 区段 type、`data-finished`、live 标记 | `parser.mjs` |
| 两队名称、简称、队标 URL | `.match-info-header-opponent` | `parser.mjs` `team()` |
| 大比分 | `.match-info-header-scoreholder-score` | `parser.mjs` |
| 赛制 BoN | header 文本里的 `Bo\d` | `parser.mjs` |
| 赛事名、赛区（按页面路径推断）、`sourceUrl` | `.match-info-tournament-name a` | `parser.mjs` `region()` |

**没有的数据**：小局（每张地图的比分）、地图名、对阵树、积分榜、参赛队、阵容、奖金、赛事日期范围和赛制说明。

请求节流（`center.mjs` `source()`）：所有 parse 共用一道闸门，间隔 ≥30 秒；失败退避 5 分钟；遵守 `Retry-After`；UA 为 `OWQS-EventCenter/1.0 (EVENTS_CONTACT|PUBLIC_ORIGIN)`；带 `Accept-Encoding: gzip`。刷新频率由 `freshness.mjs` 决定：平时 15 分钟一次，24 小时内有比赛时 5 分钟，临近开赛或进行中时 1 分钟。**现状符合 parse 限额。**

### 1.2 外链现状

| 位置 | 外链 | 处理 |
|---|---|---|
| `frontend/web/events.js:332-345` 每张比赛卡的「赛事详情 ↗」 | Liquipedia 赛事页 | **改为本站详情页**，这是本方案的主体 |
| `frontend/web/events.html:26` 页脚 | Liquipedia:Matches 和 CC BY-SA 3.0 | **保留**（署名义务） |
| `center.mjs:330` 接口 `source` 字段 | 同上 | 保留 |
| `events.js:348-357` 直播按钮 | B 站、Twitch、SOOP 官方频道 | 保留（官方直播只能外链） |
| 队标 | 已改为 `/api/v1/events/logos/{hash}` | 已完成 |

## 2. Liquipedia 还能提供什么

### 2.1 三种获取方式

| 方式 | 是否合规 | 限额 | 优点 | 缺点 |
|---|---|---|---|---|
| A. `action=parse&page=<赛事页>&prop=text` | ✅ API | **1 次/30 秒**，与赛程同步共用 | 拿到最终渲染结果：队名已解析、队标、小局弹窗、积分表都在里面 | 最贵；HTML 结构可能变；需要单独写解析器 |
| B. `action=query&prop=info\|revisions` | ✅ API | 1 次/2 秒 | 一次最多查 50 个页面的 `lastrevid`，用来做**变更检测**；也能取 wikitext | 直接解析 wikitext 模板很脆弱（队伍模板、默认值、胜者推导都要自己实现） |
| C. LiquipediaDB API（`api.liquipedia.net`，v3） | ✅ 需申请 API Key | **60 次/小时** | 结构化 JSON：match2（含每张地图）、tournament、standings、placement、squad | 需要申请，审批结果未知；免费档仅限「教育用途 / 非商业公开网站」；字段文档登录后才能看 |

**建议**：第一期用 **B 做变更检测 + A 只解析有改动的页面**；同时申请 C，批下来后在第三期把解析层切到 C，A 只作兜底。B 不能替代 A 做内容解析。

关于 C 的资格：站长已确认（2026-11-06）本站是爱好者项目，没有商业需求，符合免费档「非商业公开网站」的条件，可以申请。申请需要站长本人到 liquipedia.net/api 提交。拿到 Key 后放进 `.private/` 或服务环境变量，不能进仓库。

### 2.2 值得搬过来的内容

成本单位：一个赛事页刷新一次 = 1 次 parse（≈ 30 秒闸门内的一个名额）。

| 内容 | 页面里的位置（方式 A） | LPDB 等价（方式 C） | 价值 | 抓取成本 / 风险 |
|---|---|---|---|---|
| 赛事信息：名称、日期范围、地点、赛制、奖金总额、主办方 | Infobox（`.fo-nttax-infobox`） | tournament | 高 | 低；赛事页一次 parse 全部带出 |
| 赛程与赛果（整阶段，不只近期 50 场） | Matchlist / Bracket 中的 `brkts-match` | match2 | 高 | 中；大赛事会拆子页，例如 `/Regular_Season`、`/Playoffs`，每个子页 1 次 |
| **小局：每张地图的名称、比分、胜方** | `brkts-popup` 里的 map 行 | match2games | 高（用户最想看） | 中；结构相对稳定 |
| 对阵树（单败/双败） | `.brkts-bracket` 的轮次和列 | match2（bracketdata） | 高 | **高**；布局语义要自己还原，移动端难排 |
| 小组赛积分榜 | `.grouptable` / swiss 表 | standingsentry | 高 | 中 |
| 参赛战队 | TeamCard（`.teamcard`） | placement / squadplayer | 中 | 低 |
| 阵容（ID、位置、国籍） | TeamCard 的选手列表 | squadplayer | 中 | 低；**选手照片不搬**（见第 3 节） |
| 奖金分配 / 名次 | Prize pool 表 | placement | 中 | 低 |
| 禁用英雄（如果页面有录入） | map 行里的 hero 图标 | match2games extradata | 低 | 中；只显示本站英雄头像，不用对方的图 |
| 赛事 Banner、选手照片 | — | — | — | **不搬**：版权不属于 CC BY-SA |

**预算估算**：OWCS 同时进行的阶段页面大约 6–12 个（按赛区和阶段算）。单日最多一次全量 parse 约 12 次，也就是 6 分钟的闸门时间。比赛日只对**正在比赛**的页面，在 lastrevid 变化时才重新解析，大约每 2–5 分钟一次，仍远低于 2 次/分钟的上限。已结束的赛事解析完就冻结，只在每天一次的 B 检测中发现 lastrevid 变化（赛后修订）时才重抓。

### 2.3 实测：积分排名、地图与 ban 位、阵容（2026-11-06）

对 `Overwatch_Champions_Series/2026/China/Stage_3` 发了一次 `action=parse`（约 600KB HTML，gzip 后 40KB），确认页面里有这些数据：

| 需求 | 页面里有什么 | 结构 |
|---|---|---|
| 积分排名 | 「Swiss Standings」：名次、战队、大场胜负、小局胜负、差值、每轮对手和比分、晋级标记 | `standings-*`、`standings-position-indicator` |
| 每场的地图 | 每局的地图名、模式（Control/Escort/Hybrid/Flashpoint/Push）、比分、MVP | `brkts-popup-body-*` |
| ban 位 | 每局双方各禁一名英雄（例如 Game 1：Ana / Shion） | `brkts-popup-veto-row` |
| 全赛事 ban 统计 | 「Ban Statistics」：英雄被禁的次数 | 表格 |
| 阵容 | 每队主力和教练组，含选手 ID、位置（Tank/DPS/Support）、国籍 | `team-participant-card__*` |
| 阵容变动 | 「Roster Changes」：转入和转出 | 表格 |

**没有记录「哪一队选的这张图」**。OWCS 的规则是上一张图的败方选下一张图，所以可以按这条规则推算，页面上标注「按赛制推算」；也可以不显示选图方。

英雄和地图都用本站已有的头像和中文名显示，不使用对方的图片。

## 3. 合规约束与处理

| 约束 | 条款依据 | 本方案的处理 |
|---|---|---|
| User-Agent 必须写明项目和联系方式 | 示例 `LiveScoresBot/1.0 (http://www.example.com/; email@example.com)` | 沿用现有 `OWQS-EventCenter/1.0 (...)`。建议 `EVENTS_CONTACT` 同时写网址和邮箱，**线上需确认已配置** |
| 所有 HTTP 请求 ≤ 1 次/2 秒 | “Rate limit all HTTP requests to no more than 1 request per 2 seconds.” | 新增一个**全局 Liquipedia 闸门**，覆盖 query、图片和 parse。队标 `GAP` 改为 2000ms |
| parse ≤ 1 次/30 秒 | 条款原文 | 详情页的 parse 和赛程同步共用现有 30 秒闸门。优先级：赛程（recent）> 预约核实（urgent/track）> 详情页 > 补查（backfill） |
| 只能访问 API，不能抓 HTML 页面 | 条款原文 | 只用 `api.php` 和 LPDB；**绝不**直接请求 `/overwatch/<页面>` |
| 必须支持 gzip，并复用连接 | 条款原文 | 已带 gzip；Node 的 fetch 默认 keep-alive |
| 尽量缓存，不重复请求相同数据 | “Re-use / cache your API results for as long as possible.” | 用 lastrevid 做变更检测；已结束的赛事冻结缓存；访客请求只读缓存，**永不触发上游请求**（与现有设计一致） |
| 违规会被封 IP，反复违规会永久封禁 | 条款原文 | 遇 429/503 时整体退避；记录每次上游请求的计数，便于自查 |
| 数据和文字采用 CC BY-SA 3.0 | 条款：必须署名 Liquipedia 为数据来源 | 每个详情页底部写「数据来源：Liquipedia《页面名》· CC BY-SA 3.0 · 本站已翻译整理」，并链接到原页面和许可证。页脚署名保留。我们整理后的赛事数据同样以 CC BY-SA 提供（例如 API Bot 返回也带 `source`） |
| **队标不是 CC BY-SA**，是合理使用（fair use） | commons 队标页的授权标签多为 `fairuselogo`，并注明商标权由使用者自负 | 只把队标当作识别战队的小图标（现状 32px），不二次加工、不做装饰或宣传用途、不提供批量下载；收到权利人要求时删除对应哈希。**本站缓存副本可以保留**，因为它不扩大使用范围，只换了托管位置 |
| 赛事 Banner、选手照片、Blizzard 素材 | 多为 fair use 或第三方版权 | **不搬**。赛事页头用本站自绘样式，选手只显示文字 |
| 访问可能随时被收回 | 条款：可能随时修改、暂停或终止 | 上游不可用时显示最后一次成功的缓存，并标注更新时间；保留来源链接作为兜底 |

## 4. 页面设计

### 4.1 路由

现有页面：`/tools/events.html`（列表）。

| 新页面 | URL | 说明 |
|---|---|---|
| 赛事详情 | `/tools/event.html?t=<页面路径>`，例如 `?t=Overwatch_Champions_Series/2026/China/Stage_3` | 一个阶段或赛事一页 |
| 对阵详情 | 同页 `#m=<matchId>`，打开为侧栏抽屉；手机上全屏 | 不另建 HTML，减少构建改动；可分享链接 |

`t` 参数复用 `trackedEventApi` 的白名单：只接受 `Overwatch_Champions_Series/` 开头、字符集为 `[A-Za-z0-9_/-]` 的路径，防止被当作任意页面的代理。

### 4.2 赛事详情页结构草图

```
┌──────────────────────────────────────────────────────────┐
│ ← 赛事中心                                                │
│ OWCS 2026 中国赛区 · 第三阶段           [预约本赛事全部场次]│
│ 2026-10-10 ~ 11-23 · 线上 · 奖金 ¥xxx · 8 队 · 进行中      │
├──────────────────────────────────────────────────────────┤
│ [赛程] [对阵树] [积分榜] [参赛队伍] [奖金]   ← 页内 Tab    │
├──────────────────────────────────────────────────────────┤
│ 赛程 Tab：按日期分组，复用 events.js 的比赛卡样式            │
│   20:00  [徽]  Team A   3 : 1   Team B  [徽]    BO5  >   │ ← 点击打开对阵抽屉
│ 对阵树 Tab：横向滚动列（胜者组 / 败者组 / 总决赛）           │
│   桌面端为列布局；手机按轮次折叠成列表                       │
│ 积分榜 Tab：名次 | 战队 | 胜-负 | 小分 | 差值 | 晋级标记      │
│ 参赛队伍 Tab：卡片网格（队标、队名、阵容文字列表）            │
│ 奖金 Tab：名次 | 奖金 | 战队                                 │
├──────────────────────────────────────────────────────────┤
│ 数据来源：Liquipedia「…/Stage_3」· CC BY-SA 3.0 · 已翻译整理 │
│ 更新于 11-06 20:31 · 队标为各战队商标                        │
└──────────────────────────────────────────────────────────┘
```

### 4.3 对阵详情抽屉

```
┌──────────────────────────────┐
│ 第三阶段 · 胜者组半决赛 · BO5 │
│ [徽] Team A   3 : 1   Team B [徽]│
│ 2026-11-06 20:00（北京时间）  │
├──────────────────────────────┤
│ 图1 釜山（占领）      2 : 1  A ✓│
│ 图2 国王大道（运载）  3 : 2  A ✓│
│ 图3 新皇后街（推进）  0 : 1  B ✓│
│ 图4 …                         │
│ （有录入时显示禁用英雄，用本站头像）│
├──────────────────────────────┤
│ [官方中文直播（B站）] [预约]   │
│ 数据来源：Liquipedia · CC BY-SA │
└──────────────────────────────┘
```

地图名用本站的地图中文名映射；未知的地图显示原文。列表页每张比赛卡的「赛事详情 ↗」改为站内链接「详情」，点击后进入赛事详情页并打开该场的抽屉。

## 5. 抓取与缓存策略

```
定时任务 alarm()
 ├─ 现有：近期赛程同步（recent，最高优先级）
 ├─ 现有：预约核实 / 补查
 ├─ 新增 detail.check()   每 6h 一次；比赛日活跃页面每 5 分钟一次
 │    action=query&prop=info&titles=A|B|…（≤50 个/次，走 2 秒全局闸门）
 │    → lastrevid 与缓存一致：跳过
 │    → 不一致：放入 parse 队列
 └─ 新增 detail.work()    每轮最多 1 个页面，走 30 秒 parse 闸门且让位给 recent
      action=parse&page=X&prop=text&format=json → 解析 → 存 detail:<path>
      顺带：页面里新出现的队标交给现有 EventLogos.sync()
```

- **哪些页面进入跟踪**：近期赛程快照中出现过的 `sourceUrl`（会自动发现子页），加上有人打开过的详情页（仍受路径白名单约束）。已结束超过 14 天的页面降为每 7 天检测一次。
- **访客首次打开一个从未缓存的页面**：放入队列，返回 202 和「正在整理，约 N 秒」，前端轮询。行为与现有的日期补查一致。
- **存储**：继续放在 `events` 命名空间，键为 `detail:<path>`，值为 `{ revid, fetchedAt, info, stages[], matches[], standings[], teams[], prizes[] }`。单页限制 512KB，`parse` 响应限制 2MB（沿用 `MAX_BYTES`）。
- **解析失败**（结构改变）：保留旧缓存并标注「上游格式变化」，不覆盖成空数据；输出报警日志。
- **全局闸门**：把 `refreshAfter` 拆成两层，`lpGeneralAt`（2 秒，所有请求）和 `lpParseAt`（30 秒，仅 parse），队标下载也走 `lpGeneralAt`。

## 6. 改动文件清单

| 文件 | 改动 |
|---|---|
| `backend/src/events/logos.mjs` | `GAP` 改为 2000；接入全局 2 秒闸门（**第 0 期**） |
| `backend/src/events/source.mjs` | 新增 `detailParseApi(path)`、`revisionApi(paths[])`，复用路径白名单 |
| `backend/src/events/detail-parser.mjs`（新） | 解析 infobox、matchlist/bracket、popup 小局、grouptable、teamcard、prizepool |
| `backend/src/events/details.mjs`（新） | 跟踪列表、lastrevid 检测、parse 队列、缓存读写 |
| `backend/src/events/center.mjs` | `alarm()` 接入 detail；新增 `/detail` 路由；闸门拆为两层。**与提醒会话可能冲突**：`source()` 的 urgent 逻辑由 `4211c6b` 修改过（已推送），动手前先 rebase |
| `backend/src/api/v1.mjs` | `GET /api/v1/events/detail?t=` |
| `contracts/openapi.yaml` | 新接口的 schema（API Bot 也能用） |
| `frontend/web/event.html`、`event.js`、`event.css`（新） | 详情页和对阵抽屉 |
| `frontend/web/events.js` | 「赛事详情 ↗」改为站内链接 |
| `scripts/build-web.mjs` | 把 `event` 页面加入构建，与 events 同样的模板注入；CSP 不变 |
| `source/` 地图中文名映射 | 若已有则复用，否则新增 |
| `test/events/events-detail*.test.mjs`（新） | 解析器 fixture、闸门间隔、白名单、202 流程、署名字段存在 |
| `README.md`、`STANDALONE.md` | 更新请求频率说明 |

**不需要改**：`deploy/nginx-https.conf`、`backend/src/worker.mjs`、`scripts/build-web.mjs` 中的 CSP，三处已不含 liquipedia。

## 7. 风险

1. **parse 预算紧**：比赛日三个赛区同时开赛时，1 分钟一次的赛程同步加上详情解析会排队。缓解：详情让位于赛程，并显示「更新于 X 分钟前」；小局数据晚几分钟可以接受。
2. **HTML 结构变化**：方式 A 依赖 `brkts-*` 等 class 名。缓解：保留旧缓存、fixture 测试、尽早申请 LPDB。
3. **对阵树渲染复杂**：建议放到第二期，先做赛程、小局和积分榜。
4. **队标商标风险**：低。保持仅用于识别的用途，并留好删除通道。
5. **LPDB 申请被拒或要求付费**：继续用方式 A 即可，不影响上线。
6. **线上 1Panel 配置漂移**：仓库里的 CSP 已去掉 liquipedia，但线上 OpenResty 站点配置由面板托管，不一定读取 `deploy/nginx-https.conf`。

## 8. 分阶段计划

| 期 | 内容 | 本地可测 | 需线上验收 |
|---|---|---|---|
| **0（建议马上做，很小）** | 队标 `GAP` 改为 2 秒并接入全局闸门；核对线上 1Panel 的 CSP 响应头；确认线上已设置 `EVENTS_CONTACT`（网址加邮箱） | 单测验证下载间隔 | `curl -I https://owqs.lyzi.cloud/tools/events.html` 查看 CSP；检查服务环境变量 |
| **1** | 后端 detail 管线（B 检测 + A 解析）+ 赛事详情页（信息、赛程、积分榜、参赛队）+ 对阵抽屉（小局）+ 列表链接改为站内 | 解析器用保存的 parse JSON fixture 测试；`npm run build`、`npm test`；本地 dev 服务器用 mock fetch 预览页面 | 真实上游的请求间隔和 429 情况（看日志）；真实赛事页能否解析；手机排版 |
| **2** | 对阵树、奖金、禁用英雄 | 同上 | 同上 |
| **3**（视 LPDB 审批） | 解析层切到 LPDB（≤60 次/小时），parse 只作兜底 | mock 测试 | 拿到 Key 后联调 |

更新日志只写用户能看到的部分，例如「赛事中心新增赛事详情页，可在站内查看每张地图比分和积分榜」。闸门和间隔调整属于内部改动，用 `chore:`，不写进更新日志。

## 9. 需要你确认

1. 是否先做第 0 期的限速修正？改动小，但属于合规问题。
2. 站点是否属于「非商业公开网站」，是否要申请 LPDB 免费 Key？申请需要你本人提交。
3. 第一期范围：是否先不做对阵树？
4. 详情页 URL 形式用 `/tools/event.html?t=...` 是否可以？

## 10. 实施进度与交接（2026-11-06，进行中）

用户已确认：开始第 0、1 期；选图方**按赛制推算**（上一图败方选下一张，第 1 张图不标）。

### 已完成（在分支 `wip/events-detail`）
- **第 0 期**：`center.lpSlot()` 让所有发往 Liquipedia 的请求（parse、query、队标）串行，间隔 ≥2 秒；`logos.mjs` 去掉 500ms 间隔，改用 lpSlot，并把 `PER_RUN` 改为 6。注入了 mock fetch 的测试默认不等待，也可以用 `EVENTS_LP_SPACING_MS` 指定间隔。
- `backend/src/events/glossary.mjs`：英雄和地图英文名转中文，图片只用本站 `/media`。Shion、Doctrine 等不确定的英雄保留英文名，不显示头像。
- `backend/src/events/detail-parser.mjs`：`parseDetailPage(html, page)` 解析 infobox、每场比赛（每局地图/模式/比分/胜方、推算的选图方 `picker`、双方 ban `bans[0|1]`、MVP）、积分榜（swiss/group，group 只保留最新一周）、参赛队与阵容（Main/Staff，选手 ID、位置、国籍）。用 2026 国服第三阶段的两个真实页面验证过：主页面 9 场、常规赛 30 场、积分榜 2 张、8 支队伍。
- `backend/src/events/source.mjs`：新增 `detailPath`（白名单）、`detailRoot`（子页面归到所属阶段）、`detailParseApi`、`detailRevisionApi`。
- `backend/src/events/details.mjs`：`EventDetails`，包括 `view()`（只读缓存，首次访问返回 202 并排队）、`work()`（每次 alarm 只做一件事：解析一页，或做一次 revid 检测）。解析之间至少隔 2 分钟，且排在赛程同步和补查之后；revid 检测对活跃赛事每 10 分钟一次，其他赛事每 6 小时一次；单页存储上限 120KB。
- `center.mjs`：`source()` 新增 `read` 和 `maxBytes` 参数；新增 `GET /detail?t=` 路由；`alarm()` 调用 `details.work()`；`schedule()` 在 `details.wanted` 为真时 10 秒后再唤醒。
- `logos.mjs`：新增 `resolver()`，详情页的队标同样改为本站地址。

### 第 1 期收尾（2026-11-06 完成）
1. 两个调用次数失败已修复实现：详情改为只处理访客打开过的页面（不再按快照预取活跃赛事）；本轮告警已向 Liquipedia 发过请求（`lpSent` 计数，含赛程、补查、队标）时 `details.work()` 不发请求；距下一次赛程刷新不足 35 秒时不解析，避免 30 秒 parse 闸门推迟比分更新。子页面链接归到所属阶段（`detailRoot`）。
2. `test/events/events-detail.test.mjs`（fixture 在 `test/events/detail-fixture.mjs`）：解析器、选图方推算、白名单、202 → ready、revid 未变不重解析、闸门与 lpSlot 间隔、队标本站化、`source` 署名、API 路由、列表链接与后端 id/root 一致。
3. `GET /api/v1/events/detail?t=` 与 `contracts/openapi.yaml`。
4. 前端 `frontend/web/event.{html,js,css}`，由 `scripts/build-toolkit.mjs` 构建为 `public/tools/event.html`；赛事列表 OWCS 比赛的「赛事详情」改为站内链接（规则在 `events-model.js`）。
5. README / STANDALONE 请求频率说明已更新。

### 待线上验收
- 真实上游的请求间隔（日志）、其他赛区（NA、EMEA、Korea 等）页面能否解析、手机排版、从赛程列表 `#m=` 定位到对阵。
