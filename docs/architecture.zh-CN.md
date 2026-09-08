# 架构说明

## 数据链路

`codex app-server` 通过 stdio 输出 JSON-RPC。Electron 主进程启动并管理子进程，每两秒扫描线程元数据，并增量读取 thread/list 返回的本机 rollout 路径中的生命周期事件；按 Goal、最近 Turn、线程运行态、计划和动作类型归一化成任务快照。脱敏后的事件写入本地 outbox，再经 HTTPS `POST /codex-assistant/api/v2/events` 发送到服务端。

Fastify 服务端只拥有 CodexAssistant 自己的 SQLite 文件。事件以 `(device_id, local_sequence)` 幂等，服务端序号是全局游标；任务快照按 `(device_id, task_id)` 保存。Android 前台服务通过 WebSocket 完成 auth、subscribe，服务端先回放游标之后最多 500 条事件，再发送当前快照校准；Compose 界面只订阅进程内状态流，不建立第二条连接。

## 分层职责

- 协议层：TypeBox 严格校验，所有对象 `additionalProperties: false`。
- 采集层：仅通过官方 thread/list 返回的 rollout 文件路径增量读取生命周期事件（task_started、task_complete、turn_aborted），不读取 Codex SQLite，不上传原始 JSONL、正文或路径。
- 脱敏层：路径、密钥样式、标题长度和换行在离开桌面端前处理。
- 传输层：有效 outbox 持久化待上传事件并在重启后重试；幂等序号防止重复写入。损坏或格式不符的 outbox 当前会被桌面启动逻辑删除重建，不能保证这部分未上传事件可恢复。
- 服务层：鉴权、幂等、游标回放、广播、追踪和健康指标。
- 展示层：任务卡片只消费脱敏快照；连接配置页接收用户输入的 Token 并交给凭据存储。桌面 connection.get 不向 renderer 返回已保存的 Token。

## 明确不做

不接入任何第三方推送服务，不上传推送令牌，也不保留推送 API。Android 的后台同步和任务变化通知完全由前台服务、WebSocket 和本地 NotificationManager 完成。国产 ROM 的自启动、电池策略和锁屏限制由设备系统控制，不能由服务端绕过。新增能力必须先扩展严格协议并重新发布 schema，不写迁移或 fallback。

## Windows 运行态来源

独立启动的 app-server 与 Codex 桌面正在使用的服务实例不同。它报告的 `notLoaded` 不能解释为任务空闲。本机 `LifecycleReader` 从明确的 `task_started`、`task_complete`、`turn_aborted` 事件提取回合状态；官方 `runtimeStatus` 仍保留 `notLoaded`，不会伪造 `activeFlags`。

冷启动从文件尾向前查找，随后只读新增字节；每线程每轮读取预算为 2 MiB，未完整写入的行暂存，单条未完成记录上限为 1 MiB。文件被替换、缩短或路径变化时重建游标。读取失败或尚未追上文件时保留最后有效快照并标记 stale，无缓存时标记 unavailable。文件路径与正文不进入网络载荷或 trace。

这条生命周期链路只能证明开始、完成和中止；它无法观测另一个进程的审批等待标志。若 Codex 异常退出且没有写入终止事件，也不能仅凭时间猜测已完成。详细等待状态仍依赖官方状态或 Goal，不能宣称所有运行细节都能从本机事件恢复。

## 运行中的约束

桌面详情缓存按线程元数据、官方状态、计划修订及收到的 Turn 通知失效；生命周期文件独立增量读取，避免元数据未变化时漏掉开始/终止事件。官方通知仅来自监控自己启动的 app-server，不代表已订阅 Codex 桌面进程。轮询本身有重入保护，耗时超过两秒不会同时启动第二轮。

Android 使用进程内 SyncCoordinator 统一入口；Compose 订阅 StateFlow，前台服务维护生命周期并生成通知。当前连接状态和重试计数来自 TaskRepository，首次 snapshot 前不显示已连接。快速重配、慢消费者和多设备任务 ID 冲突仍需要专门压力验收，不能仅凭模块划分承诺所有竞态已消除。
