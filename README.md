# CodexAssistant

Windows 工作站采集 Codex 任务进度，经过脱敏、持久化 outbox 和 HTTPS 上传，由 Fastify/SQLite 服务保存，再以 WebSocket 同步给 Android。Windows 和 Android 均支持执行计划、按需回合摘要、消息发送、结构化交互、连接设置及主题切换。

发布状态：**已发布**。当前 Windows **2.0.16**、Android **2.0.16**（Android versionCode **19**）；协议 `codex-assistant.v3`，SQLite schema 为 **6**。根工作区、服务端、协议 npm 包版本仍为 2.0.0。2026-09-16 已部署生产服务并更新公网联合下载清单；服务 release 为 `private-release-id`。

下载：[Windows 2.0.16](https://server.example.com/codex-assistant/downloads/CodexAssistant-2.0.16.exe)（未签名）、[Android 2.0.16](https://server.example.com/codex-assistant/downloads/CodexAssistant-2.0.16.apk)（Release签名）。Android 2.0.16修复后台通知合并、重连补报和长期订阅，新增设置→通知→允许后台持续连接。两份文件已通过公网完整下载SHA-256校验；安装及真机运行的覆盖范围见[验收记录](docs/acceptance.zh-CN.md)。

## 使用边界

- 当前部署面向一个工作站、共享 Token 的个人使用。Token 持有者具有同等访问权限，不提供多用户隔离。只允许一个在线工作站控制器，不支持多个工作站同名任务的合并。
- Windows 通过官方 `codex app-server` 读取元数据与详情，通过其明确返回的 rollout 文件补充生命周期证据。不读取 Codex 数据库。
- 普通消息经本机 Codex Desktop 的 app-tools 管道提交，必须保持 Desktop 运行。该管道不是公开稳定 API，需随 Desktop 更新验收。`started` 只表示接受消息，不表示回合完成。
- 自动同步不上传完整对话、命令正文、输出、绝对路径或隐藏推理。用户主动发送的消息、主动读取的摘要与结构化交互会经服务透传。
- Android 用前台服务、唯一 WebSocket 和系统通知同步；设备系统决定后台执行和通知权限。
- 所有端仅接受当前协议。旧 schema、未知字段、损坏 outbox 直接报错，不提供迁移、兼容层或静默重置。

## 开发

需要 Node.js ≥22.19.0、npm、已登录且可执行 `codex app-server` 的官方 Codex。Android 使用 JDK 17、Android SDK 35 和仓库 Gradle Wrapper，最低 API 26。Windows 脚本使用 PowerShell。`CODEX_BIN` 可指定官方可执行文件位置。

```powershell
npm ci
npm run build
npm test
npm run check:format
npm run check:docs
npm run check:design
$env:CODEX_ASSISTANT_ACCESS_TOKEN = 'replace-with-a-long-random-token'
$env:CODEX_ASSISTANT_STATE_DIR = (Join-Path $PWD '.state')
npm run dev:server
```

服务默认监听 `127.0.0.1:3240`；另开终端运行 `npm run dev:desktop`。两端配置相同 HTTPS **根地址**及 Token，不追加 API 路径；本地调试允许回环 HTTP。关闭 Windows 窗口后托盘继续采集，托盘菜单“退出”才停止。

```powershell
cd android
.\gradlew.bat checkKotlinFormat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

Kotlin格式化使用Gradle维护工具 `formatKotlin` / `checkKotlinFormat`（ktfmt 0.64），不进入APK；TS/JS/CSS/HTML使用Prettier。

模拟器通过 `adb -s emulator-5580 reverse tcp:33241 tcp:33241` 访问隔离验收服务，地址 `http://127.0.0.1:33241`。不得把真实会话或用户手机作为默认自动测试目标。

## 项目结构与质量入口

|目录|职责|
|---|---|
|packages/protocol|TypeBox 协议与诊断安全规则|
|apps/server|HTTP、WebSocket 路由、SQLite、实例级 OTel|
|apps/desktop|Electron、官方读取、Desktop 消息通道、持久化队列与界面|
|android|Compose、连接协调、OkHttp、Keystore、本地通知|
|docs|当前设计、协议、运维、验收；前端规格可重新生成|
|deploy / scripts|部署模板、构建、质量检查和隔离验收|

完整入口见 [文档索引](docs/README.md)。[验收记录](docs/acceptance.zh-CN.md)区分实测、目标和限制；[性能说明](docs/performance.zh-CN.md)给出负载口径，不能把本机数据当生产 SLA。

## 构建、部署与清理

安装包构建见 [发布说明](docs/release.zh-CN.md)，服务配置见 [部署说明](deploy/README.md)和[运维手册](docs/operations.zh-CN.md)。本地构建不发布；运行 `scripts/deploy-production.ps1` 才会修改目标服务器。

停止本项目构建及调试进程后，用 `npm run clean -- -WhatIf` 预览，再运行 `npm run clean`。清理固定生成目录（含整个 artifacts 内的安装包与验收截图）、构建缓存和报告；保留依赖、业务 `.state`、Gradle Wrapper、本地 SDK 配置和仓库外签名材料。需要保存的最终产物先复制到工作区外。源码仓库不保存阶段报告、历史截图或发布过程日志。
