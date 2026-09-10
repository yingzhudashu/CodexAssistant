# 运维手册

生产安装专用 `codexassistant` 用户，将干净 release 放到 `/opt/codex-assistant/releases/<id>`，`current` 指向当前版本。状态目录为 `/var/lib/codex-assistant`，环境文件 `/etc/codex-assistant/codex-assistant.env` 权限 0600，至少包含长度不小于 16 的 `CODEX_ASSISTANT_ACCESS_TOKEN`。

```bash
systemctl daemon-reload
systemctl enable --now codex-assistant.service
curl -fsS http://127.0.0.1:3240/codex-assistant/health
nginx -t
systemctl status codex-assistant.service --no-pager
```

Nginx 必须保留 `/codex-assistant/` 前缀，并为 `/api/v3/stream` 设置 WebSocket upgrade。staging 使用 3241、独立状态目录、独立 Token 和 `staging.robotclaw.site`。

## 故障处理

- `SCHEMA_MISMATCH`：停止服务，备份旧数据库后部署干净状态；不执行 migration。
- outbox 持续增长：检查公网入口、Token、Nginx upgrade 和服务端 health/日志。
- WebSocket 频繁断开：检查证书、反代超时和 Android 网络；客户端会携带持久化 cursor 回放。
- app-server 超时：检查 `codex` 可执行文件和登录状态；trace 只记录诊断事件，不保存原始 stderr；单个线程失败不会阻塞其他线程。

发布回滚只能切换到上一份已验证 release。若数据库 schema 不一致，旧 release 也必须停止，不能强行复用新数据库。

## CodexAssistant 发布

在 Windows 工作区执行 `scripts/deploy-production.ps1`。脚本使用 `/opt/node-v22.23.2-linux-x64/bin/node`，生产 release 位于 `/opt/codex-assistant/releases`，状态位于 `/var/lib/codex-assistant`。current 符号链接原子切换；Nginx 主配置由脚本直接写入并在 reload 前执行 nginx -t，不能视为配置文件原子更新。首次部署后用 `sudo cat /etc/codex-assistant/codex-assistant.env` 在受控终端取得 Token，不要复制到文档、日志或聊天记录。

部署默认入口为 `/codex-assistant/`，服务监听 `127.0.0.1:3240`；上线后必须实际检查 health 和一条任务同步链路。health 成功不等于桌面鉴权、outbox 上传或 Android WebSocket 已正常。通知模式为 Android 前台服务，由设备系统管理后台执行；任务状态或计划步骤变化生成本地通知，不依赖第三方推送账号。

Android 当前版本由 `android/app/build.gradle.kts` 的 `versionName` 与 `versionCode` 定义，发布脚本会从源码读取。发布目录中的 APK 必须由本次构建生成，并通过签名和 SHA-256 校验后再上传。

服务端 schema 当前为 6，仅包含 `devices`、`task_events`、`tasks` 和 `trace_spans`。应用直接拒绝旧数据库；生产部署脚本在 schema 不匹配时停止服务、保存旧库及 WAL/SHM 并创建干净状态，同 schema 更新复用现有数据库。手工部署需执行同样的备份步骤。数据库不保存 Android 推送令牌或厂商凭据。

## Android 设备策略

- Android 13（API 33）及以上首次启动会请求“通知”权限。拒绝后 WebSocket 仍可工作，但常驻通知和任务变化通知不可见；应在系统设置中为 CodexAssistant 重新开启通知。
- 首次配置 Token 后，应用以前台服务方式启动同步。服务返回 `START_STICKY`，被系统回收后允许系统重建；用户在设置中强行停止应用时不会自动恢复，必须重新打开应用。
- 华为、小米、OPPO、vivo 等系统需允许自启动、后台运行和锁屏显示通知，并将 CodexAssistant 加入电池优化白名单。各 ROM 菜单名称随系统版本变化，以设备设置为准。
- Android 15 对 `dataSync` 前台服务存在系统时长和后台启动限制。服务在 onTimeout 中主动停止服务和订阅，重新进入前台时恢复同步；模拟器缩短时限测试通过，不能视为已通过全天后台运行验收。
- 任务变化通知使用单独通知渠道。用户可以在系统设置中调整声音、振动和锁屏显示；关闭该渠道不会影响同步本身，只会隐藏变化提醒。

真实设备验收至少覆盖：锁屏持续同步、断网重连、进程被回收后的重建、通知点击回到主界面，以及四类国产 ROM 的自启动和电池策略。

## 客户端故障排查

- Windows 正在执行却显示空闲：先确认已安装当前版本。`notLoaded` 是独立 app-server 的观测结果；任务展示状态还需查看本机会话的最近回合和当前操作。如果错误代码为 `ACTIVE_EVIDENCE_EXPIRED`，说明尚未结束的回合超过 30 分钟没有文件写入且没有 `inProgress` 操作，或带进行中操作但已超过 6 小时，不能理解为已证实停止。
- 历史任务误报运行中：安装 Windows 2.0.12，保持采集器运行直至完成扫描与上传。过期的历史开始标记会改为 needs_action（待确认），runtimeStatus=idle、freshness=stale，明确提示运行状态待确认；缓存和读取失败路径都会重新判断有效期。v3 Android 消费修正后的快照；从 v2 升级时必须三端同步更新，schema 不一致时使用干净数据库。
- Android 检查更新：需要可访问 `/codex-assistant/downloads/manifest.json`。网络请求在 IO 线程，版本按 Android versionCode 判断，下载按钮交给系统浏览器。
- Android 认证失败：检查 Token 是否完整。认证失败与网络断开分别显示，不进行无意义重试；修改配置并保存后重新认证。
- 任务变化通知：标题以变化后的中文状态开头，正文显示前后状态，展开后包含任务及当前步骤。连续变化在十秒内静默更新最终状态。
- Trace 保留：启动及每千次写入后清理到最近 100,000 条，不删除业务事件，不缩小已经分配的 SQLite 文件。
- 时间相差八小时：当前 Windows 2.0.12 / Android 2.0.10 均按设备时区显示任务时间。检查时间右侧偏移量：中国标准时间应为 +08:00 / GMT+8。如果设备本身设为 GMT，应在系统设置修正时区；应用不自行猜测时区。
- 任务时间没有每两秒变化：任务更新时间只随来源数据变化，状态变化时间只随生命周期变化。应区分任务时间和 Windows 底部的最后采集时间。

## 本地状态恢复

Windows 连接保存在 Electron userData 下的 connection.json，待上传事件位于 state/outbox.json。当前启动逻辑在 OUTBOX_INVALID 时停止同步并保留原文件，不自动删除重建；需要人工核实并恢复同一设备的有效备份。服务端以设备 ID 与本地序号幂等，序号重置会命中已有记录，因此禁止删除 outbox 后以原设备 ID 从 1 重新上传。凭据格式不正确时，重新保存配置也会删除旧连接文件再生成当前格式，不存在字段迁移。

Android 在 Keystore 数据损坏时清除不可恢复 Token 和 cursor，让用户重新配置。Token 长度至少 16 个字符；粘贴后确认没有前后空白或缺失字符。恢复连接后先接收快照再启用变化通知。

## 服务端环境变量

| 变量 | 开发入口默认值 | 用途 |
| --- | --- | --- |
| CODEX_ASSISTANT_HOST | 127.0.0.1 | 监听地址 |
| CODEX_ASSISTANT_PORT | 3240 | HTTP/WebSocket 共用端口 |
| CODEX_ASSISTANT_STATE_DIR | /var/lib/codex-assistant | SQLite 所在目录；Windows 开发需显式设置 |
| CODEX_ASSISTANT_ACCESS_TOKEN | 无有效默认值 | 少于 16 个字符时拒绝启动 |

桌面 CODEX_BIN 仅覆盖官方 Codex 可执行文件位置。不要将连接 Token 写入项目文件或命令历史。清理开发产物使用 `npm run clean`；该命令不清除业务状态，也不代替 outbox 恢复操作。

Android 15 达到 dataSync 前台服务时限后，onTimeout 主动停止服务与订阅，避免系统超时崩溃；应用重新进入前台时通过 onStart 恢复同步；停止时界面立刻显示离线，不保留假的已连接状态。服务端关闭 WebSocket 时客户端应答关闭帧后重连，不能停留在半关闭状态。

Windows 更新使用 semver 比较清单版本；版本无效直接报错，旧版本及同版本均不提示更新。
