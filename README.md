# 快速强度图 Cloudflare 共享版

本机工具位于相邻 `quick-strength`，云端项目不修改它。`source` 保存评分、强度预测、图表和素材的独立源码快照，可在 GitHub／Cloudflare 上独立构建；仅替换认证、缓存及 API。本机算法更新后，可手动运行 `node scripts/sync-local.mjs` 同步白名单源码。

## 使用与管理

- `/login`：邮箱＋密码申请和登录。申请由管理员人工核验邮箱归属。
- `/admin`：独立管理员密码登录；批准、拒绝、撤销授权、调整额度、处理密码重置申请。
- 密码至少10字符，玩家登录30天，管理登录2小时。管理员生成的重置链接30分钟有效、只能使用一次。
- `access-policy.json` 仅初始化一次；部署不会覆盖后台授权记录。默认每天查询10次、AI100次，北京时间零点重置。
- 每用户同时一个查询和一个AI任务，不同用户独立执行。重复点击复用任务；限流暂停查询，30秒后可点击继续。
- IndexedDB 保存对局、签名及锐评。清理浏览器数据或换设备需要重新查询。云端仅保存账号、会话、额度和短期任务，任务完成/失败一小时删除。
- 请求不自动重复发送AI，超时后可能已经产生供应商费用；请确认后手动重试。网站AI额度失败时返还，不代表供应商退款。

## 构建与部署

`npm ci`、`npm run build`、`npm test`、`npm run check`。`npm run login` 打开官方OAuth，登录文件与日志留在项目私有目录。

`npm run deploy` 发布 Workers 和静态资源、自动创建 SQLite-backed Durable Object 绑定。

Cloudflare Workers Builds 绑定私有仓库的 `main` 分支；根目录 `/`，构建命令 `npm run build && npm test`，部署命令 `npm run deploy:ci`。临时429/502/503/504网络错误最多重试3次；权限、构建或语法错误不重试。不用 GitHub Actions 保存部署密钥，不启用预览分支部署。平台运行 Secrets 与 Git 仓库分离。

部署后由使用者运行 `scripts/Setup-Admin.ps1` 的隐藏密码窗口；该窗口将本机已加密保存的大神/DeepSeek凭证直接传入 Wrangler 的标准输入，写入 Workers Secrets。管理员密码仅生成散列；本地备份为 Windows DPAPI 加密的 `.private/cloud-secrets.dpapi`。

首次配置需要这些 Secrets：`DASHEN_ROLE_ID`、`DASHEN_TOKEN`、`DEEPSEEK_KEY`、`PASSWORD_PEPPER`、`CACHE_SIGNING_KEY`、`ADMIN_PASSWORD_HASH`。`DASHEN_SERVER`和`DASHEN_DTS`是普通运行配置。

不要把 `.private`、`.dev.vars`、`.wrangler`、npm缓存或本机凭证文件上传到静态目录。`public` 仅由白名单构建生成。

轮换 API 密钥可通过官方 Wrangler `secret put` 隐藏输入完成。不要重复运行首次初始化窗口来轮换 Token：它同时更新 pepper/签名，会使旧密码和缓存失效。

## 验证边界

单元与模拟上游测试、Wrangler dry-run、本地运行时测试不等于云端真实接口通过。正式使用前必须在云端完成真实查询、真实锐评和多人并发验收。免费额度不足或网易大神拒绝 Cloudflare 请求时不自动购买或搭建外部后端。
