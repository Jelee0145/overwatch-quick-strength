# 大神凭证获取与独立复测

`scripts/refresh-dashen-credentials.mjs` 是手动诊断工具，不由构建、服务启动或定时任务调用。它通过登录后的大神官网获取查询凭证，再分别从本机和腾讯服务器查询指定 ID。它不会修改线上配置、重启服务、建立用户查询任务或写入云端历史。

## 使用

需要 Node.js、已配置的 SSH 主机、Edge 或 Chrome，以及 Playwright 模块。Playwright 不在当前仓库的依赖内时，设置 `OWQS_PLAYWRIGHT_MODULE` 为已安装模块的绝对路径。

```powershell
node scripts/refresh-dashen-credentials.mjs --ssh-host tencent --tag 'daze#51307'
```

脚本打开独立浏览器窗口后，完成大神登录即可。登录资料复用 `.private/dashen-refresh/browser`；同一次运行在这个窗口内等待，不反复开关。可用 `--browser chrome` 改用 Chrome，`--wait-seconds 900` 延长等待。

凭证以独立文件写入 `.private/dashen-refresh/credential-<时间戳>.json`。此目录已被 Git 忽略，凭证与浏览器资料不能上传、分享或加入 `public/`。脚本不打印 token、role ID、Cookie、签名或玩家明细；取凭证失败不会保存失败响应。SSH 读取的旧 token 留在服务器内，重新获取的凭证只通过 SSH 标准输入交给临时诊断进程，不写入服务器配置。

复用已获取的文件进行复测，不需要打开浏览器：

```powershell
node scripts/refresh-dashen-credentials.mjs --ssh-host tencent --tag 'daze#51307' --from-json '.private/dashen-refresh/credential-实际时间戳.json'
```

## 结果解释

- `empty`：搜索未返回玩家 token；不能据此认定账号不存在或凭证已通过鉴权。
- `different-player`：返回的完整 ID 与指定 ID 不一致，拒绝继续。
- `ok`：返回匹配账号，随后读取首屏对局列表；同时检查 `listReadable` 和 `recentMatchCount`。
- `error`：只返回映射后的状态码，不输出可能包含凭证的异常内容。
- `tokenChanged: false`：官方重新返回了同一个 token，并不保证每次获取都会轮换凭证。

正常每次运行最多三次搜索（本机重新获取凭证、服务器旧凭证、服务器重新获取凭证）；仅在搜索成功后增加对应的一次列表请求，查询与列表之间间隔 750ms，服务器新旧对照之间间隔 1s。不要连续重复运行作为压测。

## 签名与已验证边界

2026-10-26 实测：旧的 WASM 取 token 方式返回 `825 / 签名无效`；官网代码仍提供的 SHA-1 回退签名成功取得凭证。工具仅对固定官方地址使用此兼容签名，保留登录会话与 XSRF 校验。依据为官网公开签名模块与请求模块：

- [签名模块](https://g.166.net/res/a19/umi.62c4caf0.js)
- [请求模块](https://g.166.net/res/a19/3098.7b9f4eaf.async.js)

首次成功复测：官方返回的 token 与线上现有 token 相同；`daze#51307` 在本机、服务器旧凭证和服务器重新获取凭证三组搜索中均返回空数据。未修改线上配置，也未解决上游搜索为空的问题。这个结果不支持“只要换一个新 token 即可恢复”的结论，不能单独区分凭证级风控、权限变化与数据接口异常。

随后经用户授权换另一个大神账号：使用全新隔离浏览器资料登录，在官方守望先锋角色页面确认该账号实际选中的绑定角色，再获取凭证。新 role ID 与 token 均与原来不同；用新凭证在本机和服务器分别搜索原始 ID 及新账号自身的另一个完整 ID，四组搜索仍均返回空。服务器旧凭证对这两个 ID 也为空。这个对照削弱了“仅原账号凭证受限”或“仅原始 ID 不可查询”的解释，应继续排查该数据搜索接口、请求契约或更广泛的访问限制。没有证据可以据此确认全站接口停服或昨天压测导致封禁。

默认命令针对线上配置所属的角色重新取凭证。**切换大神账号时不能沿用线上旧 role ID**；须从新登录账号自己的官方绑定角色中确认 role ID，再取其凭证。本次换号在保留已登录窗口的会话内完成；未覆盖线上配置。

后续已进一步确认：原凭证的 `/queryCard` 本人接口能返回完整匹配的目标及真实 customerToken，使用这个 customerToken 可以正常读取 12 场近期对局，两个账号的 searchSwitch 都为 1。先前直接用报告 token 访问 `/customer/*` 得到的空响应不构成有效的玩家数据可用性对照。修复、证据与边界见 [搜索空响应排查](query-search-incident-2026-10-26.md)。直接接口诊断的 `empty` 只表示此次昵称搜索为空，不能代表其他接口整体失败。

同时核对昨晚扫描报告：按完整报告去重后，2026-10-25 23:10–23:38（北京时间）共记录 10 轮、1,230 次请求，其中 4 轮触发限流，位于 9/10 req/s 档位。这是风险线索；没有证据证明短期限流与次日持续空响应必然属于同一限制机制，也不能把短时 8 req/s 无 429 当作长期安全保证。
