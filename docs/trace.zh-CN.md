# Trace 设计

服务端使用 OpenTelemetry SDK、AsyncLocalStorage 和 W3C propagator 管理标准上下文；SQLite exporter 使用有界批处理。桌面和 Android 当前使用自有轻量 span 记录器，发送同一 v2 Trace schema；不能视为三端已全部接入 OpenTelemetry SDK。系统不依赖外部 Collector。

trace ID 为 32 位小写十六进制，span ID 为 16 位小写十六进制。桌面端为每轮轮询生成 trace context，RPC 和轮询诊断使用该链路。每个 outbox 事件另建 trace context，通过 W3C `traceparent` 传给 HTTP 接收端；server.ingest 使用事件上下文创建子 span。两者并非一棵完整的跨端 trace 树。

服务端为 HTTP 请求、ingest、WebSocket auth/subscribe 写入 `trace_spans`。事件自身携带桌面端 span，服务端事件 span 通过 parent 关系关联。Android 记录 websocket connect/open/auth/subscribe、event decode、snapshot reducer 和断线事件，并通过有界异步批量请求上传到 `/traces/spans`；上传失败只保留内存队列。桌面端收到 app-server stderr 时只记录安全的诊断事件计数，绝不持久化原始 stderr。采集代码应只记录安全路由、状态码、任务 ID、阶段、延迟和计数，不应写入路径、命令、输出、Token 或对话内容。服务端 OTel exporter 使用属性名白名单；直接上传的 spans 当前仅受 schema 字段、长度与数量约束，没有同等的属性内容白名单或二次脱敏。

桌面端本地 trace 位于用户数据目录的 `state/outbox.json.trace.jsonl`，写入请求使用 mode 0600（Windows 上实际访问控制仍由用户目录 ACL 决定）。服务端查询示例：

```text
GET /codex-assistant/api/v2/traces/<32位traceId>
Authorization: Bearer <token>
```

trace 是诊断数据，不是业务状态来源。任务状态仍以 SQLite 的事件和快照为准。

服务端保留最近接收的 100,000 条 span，每 1,000 次写入清理一次，启动也会清理。查询最多返回 1,000 条，按开始时间排列；当前尚未实现完整 trace 树拓扑排序。桌面本地 JSONL 当前不自动轮转，需要关注文件大小；不能把服务端保留上限当作桌面日志上限。

Android span 链以 WebSocket 连接为单位，任务状态里保留收到的事件 Trace ID，但解码 span 没有自动接续桌面事件父子关系。待上传队列最多 100 条，溢出丢弃最旧诊断数据；父 span 索引当前未设上限。桌面本地日志追加任务串行执行，上传缓冲最多 100 条，但本地追加队列没有显式上限。

Android Trace 上传运行在独立 IO 协程；桌面会在业务上传之后等待 Trace 请求，异常被捕获，但最多 5 秒超时仍可能延长当前轮询。服务端部分业务路径同步调用 recordSpan，尚未全面隔离 Trace 写入异常。当前不能宣称“任意 Trace 故障都不影响主链路”。

排查运行误报时，先核对 task.status、freshness 和 error.code，再使用事件的 trace ID 查询上传链路；ACTIVE_EVIDENCE_EXPIRED 表示普通回合静默达到 30 分钟，或带进行中操作的回合静默达到 6 小时，不是 Trace 写入失败。内部 evidenceAt 和操作证据仅用于本地判定，不在 Trace 或任务协议中传输。
