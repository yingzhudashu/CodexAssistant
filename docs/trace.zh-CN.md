# Trace 设计

Node 端使用 OpenTelemetry SDK、AsyncLocalStorage 和 W3C propagator 管理标准上下文；本地 SQLite exporter/JSONL writer 负责离线保存和查询，不依赖外部 Collector。exporter 使用有界批处理，写入失败不会阻塞同步主链路。

trace ID 为 32 位小写十六进制，span ID 为 16 位小写十六进制。桌面端为每轮轮询创建 root trace，每个 app-server RPC、归一化、outbox 上传创建子 span；上传请求以 W3C `traceparent` 传递同一 trace ID。

服务端为 HTTP 请求、ingest、WebSocket auth/subscribe 写入 `trace_spans`。事件自身携带桌面端 span，服务端事件 span 通过 parent 关系关联。Android 记录 websocket connect/open/auth/subscribe、event decode、snapshot reducer 和断线事件，并通过有界异步批量请求上传到 `/traces/spans`；上传失败只保留内存队列。桌面端收到 app-server stderr 时只记录安全的诊断事件计数，绝不持久化原始 stderr。span 属性仅允许安全的路由、状态码、任务 ID、阶段、延迟和计数，不允许路径、命令、输出、Token 或对话内容。

桌面端本地 trace 位于用户数据目录的 `state/outbox.json.trace.jsonl`，权限为 0600。服务端查询示例：

```text
GET /codex-assistant/api/v2/traces/<32位traceId>
Authorization: Bearer <token>
```

trace 是诊断数据，不是业务状态来源。任务状态仍以 SQLite 的事件和快照为准。
