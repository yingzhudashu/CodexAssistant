# 运维手册

生产安装专用 `codexassistant` 用户，将干净 release 放到 `/opt/codex-assistant/releases/<id>`，`current` 指向当前版本。状态目录为 `/var/lib/codex-assistant`，环境文件 `/etc/codex-assistant/codex-assistant.env` 权限 0600，至少包含长度不小于 16 的 `CODEX_ASSISTANT_ACCESS_TOKEN`。

```bash
systemctl daemon-reload
systemctl enable --now codex-assistant.service
curl -fsS http://127.0.0.1:3240/codex-assistant/health
nginx -t
systemctl status codex-assistant.service --no-pager
```

Nginx 必须保留 `/codex-assistant/` 前缀，并为 `/api/v2/stream` 设置 WebSocket upgrade。staging 使用 3241、独立状态目录、独立 Token 和 `staging.robotclaw.site`。

## 故障处理

- `SCHEMA_MISMATCH`：停止服务，备份旧数据库后部署干净状态；不执行 migration。
- outbox 持续增长：检查公网入口、Token、Nginx upgrade 和服务端 health/日志。
- WebSocket 频繁断开：检查证书、反代超时和 Android 网络；客户端会携带持久化 cursor 回放。
- app-server 超时：检查 `codex` 可执行文件、登录状态和 stderr trace；单个线程失败不会阻塞其他线程。

发布回滚只能切换到上一份已验证 release。若数据库 schema 不一致，旧 release 也必须停止，不能强行复用新数据库。

## CodexAssistant 发布

在 Windows 工作区执行 `scripts/deploy-production.ps1`。脚本使用 `/opt/node-v22.23.2-linux-x64/bin/node`，生产 release 位于 `/opt/codex-assistant/releases`，状态位于 `/var/lib/codex-assistant`，并把 Nginx location 原子纳入现有 `robotclaw.site` server 块。首次部署后用 `sudo cat /etc/codex-assistant/codex-assistant.env` 在受控终端取得 Token，不要复制到文档、日志或聊天记录。

部署默认入口为 `/codex-assistant/`，服务监听 `127.0.0.1:3240`；上线后必须由运维人员实际检查 health。通知模式为 Android 前台服务：设备端由系统保活 WebSocket，并在任务状态或计划步骤变化时生成本地通知，不依赖第三方推送账号。

当前源码 Android 版本为 `2.0.0`（`versionCode=3`）。发布目录中的 APK 必须由本次构建生成，并通过签名和 SHA-256 校验后再上传。

服务端 schema 当前为 5，仅包含 `devices`、`task_events`、`tasks` 和 `trace_spans`。旧数据库直接硬失败；部署前必须备份并准备干净状态目录。数据库不保存 Android 推送令牌或厂商凭据。

## Android 设备策略

- Android 13（API 33）及以上首次启动会请求“通知”权限。拒绝后 WebSocket 仍可工作，但常驻通知和任务变化通知不可见；应在系统设置中为 CodexAssistant 重新开启通知。
- 首次配置 Token 后，应用以前台服务方式启动同步。服务返回 `START_STICKY`，被系统回收后允许系统重建；用户在设置中强行停止应用时不会自动恢复，必须重新打开应用。
- 华为、小米、OPPO、vivo 等系统需允许自启动、后台运行和锁屏显示通知，并将 CodexAssistant 加入电池优化白名单。各 ROM 菜单名称随系统版本变化，以设备设置为准。
- Android 15 对 `dataSync` 前台服务存在系统时长和后台启动限制。服务被系统按策略停止时，应用会在下一次允许的前台启动后恢复游标；这不是服务端故障，也不能通过 WebSocket 绕过系统限制。
- 任务变化通知使用单独通知渠道。用户可以在系统设置中调整声音、振动和锁屏显示；关闭该渠道不会影响同步本身，只会隐藏变化提醒。

真实设备验收至少覆盖：锁屏持续同步、断网重连、进程被回收后的重建、通知点击回到主界面，以及四类国产 ROM 的自启动和电池策略。
