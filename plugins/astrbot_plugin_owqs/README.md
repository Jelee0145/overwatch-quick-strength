# 狸狸天眼查 · AstrBot 插件

独立从网易大神查询守望先锋快速对局，复用 OWQS 的评分规则和强度图。Python 接收消息，Node.js 执行查询与分析，本机 Chromium 生成 PNG；不需要 OWQS 网站账户或网站 API。

## 安装

要求 AstrBot **4.9.2 至 4.x**、Python **3.10+**、Node.js **22+**。支持 AstrBot 可发送图片的平台，首要部署环境是 Debian／Ubuntu Linux 与 Docker。需要能从 Bot 所在网络访问网易大神。

1. 从本项目的 `dist/astrbot_plugin_owqs-1.0.0.zip` 安装包，在 AstrBot WebUI 的插件页上传 ZIP。插件根目录包含 `main.py`、`metadata.yaml`、`runtime.mjs` 和 `assets/`。
2. 使用 **AstrBot 正在运行的 Python 环境** 安装依赖和匹配版本的浏览器：

   ```bash
   python -m pip install -r data/plugins/astrbot_plugin_owqs/requirements.txt
   python -m playwright install --with-deps chromium
   # Debian/Ubuntu：安装中文字体
   sudo apt-get update
   sudo apt-get install fonts-noto-cjk
   ```

3. 在插件配置面板填写 `DASHEN_SERVER`、`DASHEN_DTS`、`DASHEN_ROLE_ID`、`DASHEN_TOKEN`。这些值使用同一组大神凭证；不要通过聊天指令填写。Node 不在 PATH 时，配置 `node_path` 为其绝对路径。
4. 重载插件，配置 AstrBot 的访问控制与消息平台，然后发送 `/owqs 帮助`。

依赖未安装时，绑定与帮助仍可使用；查询会说明缺少的依赖。修复依赖后再次查询会重新检查。

## 指令

```text
/owqs 绑定 昵称#12345
/owqs 查询
/owqs 查询 20 慢
/owqs 查询 另一个昵称#67890 5 快
/owqs 解绑
/owqs 取消
/owqs 帮助
```

默认查 10 场、快模式；省略昵称时使用绑定。昵称允许空格，场数和模式写在昵称后面。图表展示并统计最近 **10 场**，不足 10 场全部展示；选择 20 场扩大查询范围。快模式复用可用资料，慢模式按现有规则补采其他玩家的近期参考对局。图片时区固定为北京时间。

绑定按平台适配器 ID、机器人 ID、发送者 ID 隔离，同一机器人的私聊和不同群聊共用绑定。绑定仅保存查询默认值，不验证战网账号所有权。任何获准使用插件的用户均可指定其他昵称查询。

管理员的一组凭证由所有查询共用；同一插件实例同时运行 1 个查询，最多排队 5 个，每位用户最多 1 个未完成任务。重复请求不会另开任务。限流时等待 30 秒继续；默认运行超时 600 秒，不含排队，可通过 `query_timeout` 调整。失败不覆盖上次成功缓存，取消会停止当前 Node 进程。其他插件或其他 AstrBot 实例不参与本插件的排队。

## Docker

本目录内的 Docker 示例基于 [AstrBot 官方镜像](https://docs.astrbot.app/deploy/astrbot/docker.html)，额外安装 Node.js 22、固定版本 Playwright、匹配 Chromium 和 Noto 中文字体。

解压安装包后，在插件根目录执行：

```bash
docker compose -f docker/compose.yaml up -d --build
```

打开 `http://127.0.0.1:6185`，登录 AstrBot 后上传插件 ZIP 并配置。数据保存在 `astrbot_data` 命名卷。示例只映射本机管理端口；远程服务器可使用 SSH 隧道访问，消息适配器所需端口按实际配置添加。已有 AstrBot 部署可使用该 Dockerfile 构建带依赖的镜像并沿用原数据卷，不必新建实例。

可通过构建参数 `ASTRBOT_IMAGE` 指定自己的 AstrBot 4.x 基础镜像。更新 Playwright 版本时必须重新安装相应 Chromium／重建镜像。不要把大神凭证放入 Dockerfile、构建参数或镜像。

## 数据与维护

- 数据目录：`AstrBot/data/plugin_data/astrbot_plugin_owqs/`。`state.sqlite3` 保存绑定和私有查询缓存；`images/` 保存生成图片。
- 缓存按凭证范围、服务器、DTS／赛季和战网昵称隔离，复用核心原有有效期；每份结果最多保留 50 场，工作缓存最多保留最近 30 个账号范围，不提供历史浏览。轮换凭证后旧范围不再复用。
- 缓存包含上游临时玩家 token，插件配置包含大神凭证。数据目录仅供管理员访问，备份时按敏感数据处理，不应提交或公开。
- 图片保留 24 小时，在启动、出图和每小时维护时清理。插件重载／停止会关闭 Node 与 Chromium；绑定和成功缓存保留，未完成任务不会自动恢复，请重新发起。
- 评分是规则参考，不是实际快速 MMR。无可查询账号、无战绩、凭证失效、超时和出图失败均返回提示。

## 从 OWQS 源码构建

在仓库根目录执行：

```bash
npm ci
npm run plugin:build
npm run plugin:test
```

`plugin:build` 先构建共享算法，再输出插件的 `runtime.mjs`、`assets/`、ZIP 和 SHA-256 校验文件。ZIP 只包含固定白名单，不收集仓库工作目录、真实配置或缓存。解压包可独立安装，无需保留 OWQS 源码。不要直接将整个 OWQS 仓库 URL 作为 AstrBot 插件仓库安装；应使用 ZIP。

测试使用匿名模拟上游和消息适配器；真实大神访问、群聊图片传输以及 Linux Docker 启动需要在实际部署环境验收。源码中的测试不读取仓库凭证或真实账号数据。
