# CodexAssistant

CodexAssistant 是独立的 Codex 任务进度同步工具：Windows Electron 托盘端通过官方 `codex app-server` JSON-RPC 读取线程元数据，并从其返回的本机会话文件中增量提取开始、完成和中止事件，完成脱敏后通过 HTTPS 上传；Fastify 服务端写入 SQLite 并以 WebSocket 推送；Android Compose 客户端显示任务与本地通知，通过前台服务保持同步。

当前已发布版本（2026-09-10）：Windows **2.0.12**、Android **2.0.10**（Android versionCode **13**）；协议为 `codex-assistant.v3`，SQLite schema 为 **6**。根工作区、服务端和协议包的 npm 版本仍为 2.0.0，不代表客户端安装包版本。

- [Windows 安装包](https://robotclaw.site/codex-assistant/downloads/CodexAssistant-2.0.12.exe)（未签名）
- [Android APK](https://robotclaw.site/codex-assistant/downloads/CodexAssistant-2.0.10.apk)（release 签名）
- [在线更新清单](https://robotclaw.site/codex-assistant/downloads/manifest.json)

Windows 与 Android 填写同一站点根地址，例如 `https://robotclaw.site`，以及服务端配置的访问 Token。不要在地址末尾追加 API 路径。两端均提供检查更新与下载入口，下载由系统浏览器处理。

## 当前版本边界

- 协议固定为 `codex-assistant.v3`，未知字段、错误协议版本和旧 SQLite schema 直接拒绝。
- 任务状态同时包含 Goal 状态、官方线程运行态、active flags、最近 Turn 结果和数据新鲜度；Goal 优先，失败和中止的 Turn 优先于线程运行态；其余组合按[状态规则](docs/protocol.zh-CN.md)处理。
- 本机历史开始记录不永久等于运行中：普通静默回合 30 分钟后进入待确认；当前回合仍有 `inProgress` 操作时会保留进行中状态最多 6 小时，并以缓存状态展示。明确的官方运行状态不受这些窗口影响。
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

需要 Node.js **22.19.0 或以上**、已登录的官方 Codex，以及能执行 `codex app-server` 的环境。本机会话生命周期已在 Codex **0.153.4** 上验证；它不是跨进程实时状态订阅接口，限制见[架构说明](docs/architecture.zh-CN.md)。Windows 脚本需要 PowerShell。Android 构建需要 JDK 17 或以上、Android SDK 35 和仓库内的 Gradle Wrapper，应用最低支持 Android 8（API 26）；SDK 路径通过本地 `android/local.properties` 或环境变量配置，不提交版本库。

```powershell
npm ci
npm run build
npm test
npm run check:docs
$env:CODEX_ASSISTANT_ACCESS_TOKEN = 'replace-with-a-long-token'
$env:CODEX_ASSISTANT_STATE_DIR = (Join-Path $PWD '.state')
npm run dev:server
```

服务端默认监听 `http://127.0.0.1:3240`。另开终端运行 `npm run dev:desktop`，首次启动时填写服务地址和同一个 Token。若 `codex` 不在 PATH，可设置 `CODEX_BIN` 为可执行文件路径。

Windows 关闭主窗口后仍在托盘采集，使用托盘菜单“退出”停止。桌面“已连接”只表示一次采集轮询结束，不保证 outbox 已上传清空；手机必须收到服务端 snapshot 才显示已连接。排查同步延迟时按[运维手册](docs/operations.zh-CN.md)核对三端。

Android 调试构建：

```powershell
cd android
.\gradlew.bat :app:assembleDebug --no-daemon
```

## 生产部署

生产服务监听回环地址 `127.0.0.1:3240`，公网入口为 `https://robotclaw.site/codex-assistant/`。使用 `deploy/codex-assistant.service` 和 `deploy/nginx-codex-assistant.locations.conf`，staging 必须使用独立端口、状态目录、域名和 Token。完整步骤见 [`docs/operations.zh-CN.md`](docs/operations.zh-CN.md)。

从当前工作树发布服务：

```powershell
.\scripts\deploy-production.ps1
```

脚本会构建、校验 SHA-256、安装不可变 release、配置 systemd/Nginx，并检查回环和公网 health。首次部署会在服务器 `/etc/codex-assistant/codex-assistant.env` 随机生成 Token；通过受控 SSH 读取后分别配置桌面端和 Android。

失败回滚有边界：只在脚本已记录上一 release 后才能切回；systemd unit 和 Nginx snippet 不会自动恢复，详见[发布说明](docs/release.zh-CN.md)。生产配置变更前需另行备份这些文件。

Android 发布包需通过签名校验；当前 Windows 发布包未签名。真实设备后台验收与构建结果分别记录，详见发布和验收文档。

## 质量与性能

桌面轮询固定 2 秒，但仅在线程元数据或计划修订变化时重新读取详情；详情 RPC 最大并发 8、单请求超时 15 秒。上传有 10 秒超时、指数退避和 5000 条 outbox 上限。服务端限制 HTTP body 128 KiB、WebSocket 入站消息 128 KiB；单次回放最多 500 条，随后由快照校准最新状态，并在 health 接口返回 RSS、订阅数和数据库计数。桌面 Trace 追加到本地 JSONL，Android 使用内存队列上传；只有服务端接入 OpenTelemetry SDK。服务端保留最近十万条 span，其他限制见 [Trace 说明](docs/trace.zh-CN.md)。见 [`docs/performance.zh-CN.md`](docs/performance.zh-CN.md)。

## 文档入口

- [架构与状态来源](docs/architecture.zh-CN.md)、[协议和时间语义](docs/protocol.zh-CN.md)
- [Trace](docs/trace.zh-CN.md)、[性能与测试范围](docs/performance.zh-CN.md)、[安全边界](docs/security.zh-CN.md)
- [部署配置](deploy/README.md)、[运维排查](docs/operations.zh-CN.md)、[安装包发布](docs/release.zh-CN.md)
- [已验证能力与待验收事项](docs/acceptance.zh-CN.md)

## 工作区清理

关闭本项目的构建、测试和调试进程后，在 Windows 运行 `npm run clean -- -WhatIf` 预览，再运行 `npm run clean`。它删除固定的 build/dist、TypeScript 增量文件、Android 项目缓存、测试报告和整个 `artifacts`（包括本地 APK/EXE、截图和临时清单），并拒绝跟随目录链接。安装包应先发布或保存到工作区之外。

清理保留 node_modules、Gradle Wrapper、Android local.properties、业务 `.state`、已安装客户端数据与仓库外签名材料。清理后运行 `npm run build` 重建；`npm test` 会自行构建协议包。Git 只提交源码、测试、脚本、必要资源和当前文档。

## 约束

本项目只管理 CodexAssistant 自己的状态和数据库。数据库 schema 不匹配时必须重新部署干净状态，不提供 migration、兼容层或旧协议 fallback。Android 后台通知采用前台服务，系统通知权限和电池策略由用户设备控制。
