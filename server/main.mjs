// 兼容入口：已安装的 owqs.service 仍以 `node server/main.mjs` 启动。
// 服务端 unit 的 ExecStart 改为 backend/server/main.mjs 后，本文件可以删除。
import '../backend/server/main.mjs';
