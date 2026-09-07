# CodexAssistant

CodexAssistant 是独立的 Codex 任务进度同步工具：Windows Electron 托盘端通过官方 `codex app-server` JSON-RPC 读取线程进度，完成脱敏后通过 HTTPS 上传；Fastify 服务端写入 SQLite 并以 WebSocket 推送；Android Compose 客户端在打开时实时显示任务变化。

当前源码版本：`2.0.0`。桌面端、服务端和 Android 必须一起使用协议 `codex-assistant.v2`。

## 当前版本边界

- 协议固定为 `codex-assistant.v2`，未知字段、错误协议版本和旧 SQLite schema 直接拒绝。
- 任务状态同时包含 Goal 状态、官方线程运行态、active flags、最近 Turn 结果和数据新鲜度；展示优先级固定为 Goal → Turn → 线程 → 空闲。
- 不上传完整对话、文件内容、命令正文/输出、绝对路径或隐藏推理。
- Android 使用前台服务保持 WebSocket 常驻，并由系统本地通知呈现任务变化；不依赖第三方推送账号。

## 目录

- `packages/protocol`：TypeBox 严格协议、trace context 和错误码。
- `apps/server`：Fastify API、SQLite、HTTP/WebSocket 鉴权、幂等 ingest、游标回放和 trace 查询。
- `apps/desktop`：Electron 主进程、app-server RPC、轮询缓存、脱敏、outbox、托盘和任务窗口。
- `android`：Compose Material 3、OkHttp WebSocket、Keystore 凭据和断线游标恢复。
- `deploy`：systemd、Nginx 和发布说明。
- `docs`：架构、协议、追踪、性能、安全、运维和验收文档。
- `docs/release.zh-CN.md`：Android APK、Windows NSIS 和下载发布要求。
- `scripts`：生产服务部署、Android release 和 Windows 安装包构建脚本。

## 本地开发

```powershell
npm install
npm run build
npm test
$env:CODEX_ASSISTANT_ACCESS_TOKEN = 'replace-with-a-long-token'
$env:CODEX_ASSISTANT_STATE_DIR = (Join-Path $PWD '.state')
npm run dev:server
```

服务端默认监听 `http://127.0.0.1:3240`。另开终端运行 `npm run dev:desktop`，首次启动时填写服务地址和同一个 Token。若 `codex` 不在 PATH，可设置 `CODEX_BIN` 为可执行文件路径。

Android 调试构建：

```powershell
cd android
.\gradlew.bat :app:assembleDebug --no-daemon
```

## 生产部署

生产服务监听回环地址 `127.0.0.1:3240`，公网入口为 `https://server.example.com/codex-assistant/`。使用 `deploy/codex-assistant.service` 和 `deploy/nginx-codex-assistant.locations.conf`，staging 必须使用独立端口、状态目录、域名和 Token。完整步骤见 [`docs/operations.zh-CN.md`](docs/operations.zh-CN.md)。

从当前工作树发布服务：

```powershell
.\scripts\deploy-production.ps1
```

脚本会构建、校验 SHA-256、安装不可变 release、配置 systemd/Nginx、检查回环和公网 health，并在失败时恢复旧 release。首次部署会在服务器 `/etc/codex-assistant/codex-assistant.env` 随机生成 Token；通过受控 SSH 读取后分别配置桌面端和 Android。

生产发布需要独立完成签名、真实设备验收和公网部署。构建脚本会在缺少签名材料时直接失败，不生成伪生产包。

## 质量与性能

桌面轮询固定 2 秒，但仅在线程元数据或计划修订变化时重新读取详情；详情 RPC 最大并发 8、单请求超时 15 秒。上传有 10 秒超时、指数退避和 5000 条 outbox 上限。服务端限制 HTTP body 128 KiB、WebSocket payload 32 KiB、单次回放 500 条，并在 health 接口返回 RSS、订阅数和数据库计数。桌面、服务端和 Android 的安全 span 都写入本地 trace 队列，Trace 写入失败不会阻塞同步。见 [`docs/performance.zh-CN.md`](docs/performance.zh-CN.md)。

## 约束

本项目不修改 OtherService、OtherService 的领域模型和数据库。数据库 schema 不匹配时必须重新部署干净状态，不提供 migration、兼容层或旧协议 fallback。Android 后台通知采用前台服务，系统通知权限和电池策略由用户设备控制。
