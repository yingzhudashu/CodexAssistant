# Trace 设计与排障

服务端使用 OpenTelemetry SDK 的实例级 BasicTracerProvider、W3C propagator 和 BatchSpanProcessor；不注册全局 provider/context manager，不依赖 AsyncLocalStorage 或外部 Collector。桌面与 Android 使用轻量 span 记录器，发送相同严格 v3 结构。

## 链路

每轮 desktop.poll 为根；官方 RPC 是该轮的子 span。变化事件 desktop.event 继承轮询上下文，outbox 保存该事件上下文。desktop.upload 是事件子节点，其 W3C traceparent 传给 HTTP，使 http.post 继续上传链路；server.ingest 直接以载荷中的事件作为父节点。Android 的 android.sync.event 也以收到的事件 span 为父节点。HTTP 和 reducer 是同一 trace 中的不同分支，不能按时间顺序假定它们为逐级父子。

连接生命周期（WebSocket auth/subscribe、Android connect/authenticate/snapshot）使用独立连接 trace。服务端连接根上下文可无对应实体根 span；查询不保证是一棵无缺口树。断网、队列溢出、保留清理和客户端最终上传会导致缺段。业务状态和消息接受以业务回执为准，trace 不能证明执行完成。

Android通知增加 `android.sync.notification_post`（系统通知API调用耗时）与 `android.sync.notification_delivery`（事件/补齐快照接收到调用完成的本机耗时）。实时通知继承事件traceId，重连补报关联快照连接traceId；仅记录阶段、标识和非负latencyMs。通知结束后主动调度同一有界上传器。这能区分网络接收延迟和应用内等待，但不能证明系统已绘制通知或播放声音。

## 容量与故障隔离

|位置|策略|
|---|---|
|服务器 OTel|队列 2048；每批最多 256；250 ms 调度；每批一个 SQLite 事务|
|服务端直接上传|每请求最多 100 span，同时受 128 KiB body 限制；存储失败返回错误供客户端保留队列|
|桌面本地追加|等待队列 256，批量 64；溢出丢最旧诊断并计数；写入失败不抛给业务|
|桌面文件|state/outbox.json.trace.jsonl 与 .1，各最多约 5 MiB；只轮转诊断，绝不删除 outbox|
|桌面上传|内存 100；单独一个请求，5 秒 abort；按已确认 span ID 删除，停止时取消并等待|
|Android|待发队列 100、父节点索引 100；500 ms 合并，单独 IO 上传，15 秒总期限；失败保留有限队列|
|SQLite|按接收顺序保留最近 100000 条，启动及每 1000 次写入清理；清理间隔最多多 999 条|

OTel exporter 失败累计到 health.traceFailedExports，不改变已提交业务事件的成功结果。队列满可丢诊断；该指标只计导出失败批次，不计 SDK 内部所有丢弃。查询 forceFlush 当前服务实例队列，但不能等待其他设备尚未上传的数据。SQLite 清理不主动 VACUUM，也不删除业务事件。

## 诊断安全

三端 span 只记录标识、计数与固定阶段。服务端 exporter、直接上传和桌面文件均执行 safeTraceSpan：数值字段仅接受数字，路由仅保留固定 API 模板，taskId 限制字符集，source/phase 使用有限枚举，未知名称降为 diagnostic，普通错误文本转为 OPERATION_FAILED。不能把 Token、命令、完整路径、正文、原始 stderr 放入属性。此规则限制结构和常见内容，并非任意秘密识别器；taskId 仍是关联标识。

span 包含 traceId（32 位小写十六进制）、spanId/可选 parentSpanId（16 位）、name、startedAt、endedAt、可选字符串 attributes。上传验证开始结束时间可解析且结束不早于开始；跨设备时钟仍可能偏移。

## 查询

```text
GET /codex-assistant/api/v3/traces/<traceId>?limit=1000
Authorization: Bearer <token>
```

limit 必须为 1–1000 的整数；非法参数 422，无记录 404。按开始时间返回，并非拓扑排序。先按 spanId/parentSpanId 建立关系，再结合设备时钟和异步批次分析。HTTP 接收延迟、outbox 等待和设备离线是不同阶段，不要只相减两个跨设备时间。

排查顺序：任务 status/freshness/error → 当前连接与 outbox → 事件 traceId → poll/RPC/event/upload/http/ingest/reducer 分支。ACTIVE_EVIDENCE_EXPIRED 表示生命周期证据过期，与 Trace 存储失败无关。分享现场前检查本地业务配置和日志是否含秘密。
