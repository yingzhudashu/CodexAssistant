# 协议说明

协议版本固定为 `codex-assistant.v2`。桌面端、服务端和 Android 必须使用同一协议版本，旧版本直接拒绝。

## 事件

`IngestEvent` 包含 `deviceId`、单调递增 `localSequence`、`occurredAt`、`trace` 和 `task`。`ServerEvent` 在此基础上增加服务端 `sequence`。重复的设备序号返回 `duplicate: true`，不会再次广播。

任务快照包含标题、项目目录名、更新时间和变更时间，并严格拆分以下语义：

- `status` 是用户展示状态：`active`、`waiting`、`paused`、`blocked`、`usage_limited`、`budget_limited`、`idle`、`complete`、`failed`。
- `runtimeStatus` 是官方线程运行态：`notLoaded`、`idle`、`systemError`、`active`。
- `activeFlags` 只表示 `waitingOnApproval` 或 `waitingOnUserInput`。
- `latestTurn` 表示最近回合的 `inProgress`、`completed`、`interrupted` 或 `failed`，错误只保留安全代码和脱敏摘要。
- `freshness` 表示 `fresh`、`stale` 或 `unavailable`；详情 RPC 失败时不得把缓存线程改写成失败。

当前 deriveTaskStatus 按以下顺序决定展示状态（命中即返回）：

1. 存在 Goal 状态时返回 Goal 状态。
2. 最近 Turn 为 failed 时返回 failed；interrupted 时返回 idle。
3. Turn 为 inProgress 或线程为 active 时，根据 activeFlags 返回 waiting 或 active。
4. 线程为 systemError 时返回 failed。
5. Turn 为 completed 时返回 complete，其余返回 idle。

因此历史 completed Turn 不会盖过当前 active 线程，Goal 为 active 时也不会被等待标志覆盖。动作只允许 `command_execution`、`file_change`、`mcp_call`、`agent_message`，不携带正文。

上述规则用于官方基础状态。本机生命周期投影另有运行证据有效期：当 runtimeStatus 为 notLoaded、历史回合为 inProgress 且文件达到 30 分钟无写入时，没有进行中操作的回合展示 status 为 idle、freshness 为 stale、error.code 为 `ACTIVE_EVIDENCE_EXPIRED`；当前回合仍有 `inProgress` 操作时，在 6 小时内展示 status 为 active、freshness 为 stale 且不产生错误。Goal 的非 active 状态仍优先。latestTurn.inProgress 表示历史未结束标记，不能脱离 freshness 和当前操作状态解释为实时运行。恢复写入后重新投影；明确终止记录不会因时间过期而失效。内部 evidenceAt 和操作证据不进入协议载荷。

## WebSocket

客户端必须先发送严格的 `auth`，再发送一次 `subscribe` 和 `after` 游标。服务端响应 `authenticated`，随后发送游标后最多 500 条 `event`，最后发送包含所有当前任务的 `snapshot`。超过 500 条的中间历史不会继续分页发送，最新状态由 snapshot 校准；当前机制不能用于完整历史审计。未知字段、错误版本、错误顺序和超大消息直接关闭连接。

## HTTP

- `GET /codex-assistant/health`：无需业务 Token，返回协议版本、RSS、订阅数和数据库计数。
- `POST /codex-assistant/api/v2/events`：Bearer Token 鉴权，写入事件。
- `POST /codex-assistant/api/v2/traces/spans`：批量写入最多 100 个安全 span。
- `GET /codex-assistant/api/v2/tasks`：Bearer Token 鉴权，返回当前任务。
- `GET /codex-assistant/api/v2/traces/:traceId`：Bearer Token 鉴权，返回最多 1000 个 span。
- `GET /codex-assistant/api/v2/stream`：WebSocket auth/subscribe。
- Android 不登记云端推送令牌；前台服务直接使用现有 WebSocket 接收事件并生成本地通知。

Android 序列化启用 `encodeDefaults=true` 和 `explicitNulls=false`：auth/subscribe 的 type、protocolVersion 即使有默认值也必须发送，可选 null 字段则省略。必须收到 snapshot 才标记已连接；回放 event 不提前切换连接状态。重复序号忽略，snapshot 游标按服务端值校准。

## 时间语义

协议中的时间统一以 UTC ISO-8601 传输。Android 和 Windows 在显示时才转换到设备时区，包含年月日、时分秒和 UTC 偏移量；不得去掉 Z 后直接当作本地时间，也不固定加八小时。

`updatedAt` 是任务源数据的最近更新时间，不是扫描时间。对于由本机回合生命周期确定的展示状态，`changedAt` 是最近开始、完成或中止事件的时间，不随后续元数据更新而漂移；Goal 优先时保留归一化快照的 changedAt（当前来自线程元数据），它不是独立观测的 Goal 状态变更时间。缓存读取失败不把来源时间更新成现在。Windows 底部“最后采集”表示本次采集时间，不能代替任务发生时间。

运行证据过期属于观测新鲜度变化，不是已证实的任务终止，任务来源时间保持原值；此时不应把 changedAt 解释为任务实际停止时间。文件读取失败时，除了 freshness 变化，还会撤销已过期证据推断的 active。

## 连接状态与边界

Android 正常链路为 connecting → authenticating → subscribing → connected。断开后显示 offline/reconnecting 并按 1 至 6 秒延迟重试；not_configured 表示缺少 Token。auth_failed 与 protocol_error 为不可重试错误，保存配置后重建连接。当前没有独立的系统网络恢复回调，5 秒恢复目标尚未验证。

Windows 连接状态为 connecting/syncing/connected/offline，与 Android 状态机不同；connected 不代表待上传 outbox 已清空。TaskSnapshot 中 freshness 描述采集证据的新鲜度，不表示手机当前网络状态。

HTTP body 上限 128 KiB，WebSocket 的 32 KiB 限制作用于客户端入站消息，服务端任务快照没有按该大小分块。慢订阅者缓冲超过 256 KiB 时会跳过广播，目前没有强制断开以立即触发重放的机制。这些边界需纳入后续稳定性验收。
