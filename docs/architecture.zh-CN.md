# 架构说明

## 数据链路

`codex app-server` 通过 stdio 输出 JSON-RPC。Electron 主进程启动并管理子进程，每两秒扫描线程，按 Goal、线程运行态、最近 Turn、计划和动作类型归一化成任务快照。脱敏后的事件写入本地 outbox，再经 HTTPS `POST /codex-assistant/api/v2/events` 发送到服务端。

Fastify 服务端只拥有 CodexAssistant 自己的 SQLite 文件。事件以 `(device_id, local_sequence)` 幂等，服务端序号是全局游标；任务快照按 `(device_id, task_id)` 保存。Android 前台服务通过 WebSocket 完成 auth、subscribe，服务端先回放游标之后的事件，再发送当前快照校准；Compose 界面只订阅进程内状态流，不建立第二条连接。

## 分层职责

- 协议层：TypeBox 严格校验，所有对象 `additionalProperties: false`。
- 采集层：只处理官方 app-server 数据，不读取 Codex 私有 SQLite/JSONL。
- 脱敏层：路径、密钥样式、标题长度和换行在离开桌面端前处理。
- 传输层：outbox 保证重启不丢事件，HTTP 超时和指数退避保证断线可恢复。
- 服务层：鉴权、幂等、游标回放、广播、追踪和健康指标。
- 展示层：Android 和 Electron renderer 只消费任务快照，不接触 Token、路径或命令输出。

## 明确不做

不接入任何第三方推送服务，不上传推送令牌，也不保留推送 API。Android 的后台同步和任务变化通知完全由前台服务、WebSocket 和本地 NotificationManager 完成。国产 ROM 的自启动、电池策略和锁屏限制由设备系统控制，不能由服务端绕过。新增能力必须先扩展严格协议并重新发布 schema，不写迁移或 fallback。
