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

展示状态优先级固定为 Goal → Turn 结果 → 线程运行态 → 空闲状态。动作只允许 `command_execution`、`file_change`、`mcp_call`、`agent_message`，不携带正文。

## WebSocket

客户端必须先发送严格的 `auth`，再发送一次 `subscribe` 和 `after` 游标。服务端响应 `authenticated`，随后发送缺失的 `event`，最后发送 `snapshot`。未知字段、错误版本、错误顺序和超大消息直接关闭连接。

## HTTP

- `GET /codex-assistant/health`：无需业务 Token，返回协议版本、RSS、订阅数和数据库计数。
- `POST /codex-assistant/api/v2/events`：Bearer Token 鉴权，写入事件。
- `POST /codex-assistant/api/v2/traces/spans`：批量写入最多 100 个安全 span。
- `GET /codex-assistant/api/v2/tasks`：Bearer Token 鉴权，返回当前任务。
- `GET /codex-assistant/api/v2/traces/:traceId`：Bearer Token 鉴权，返回最多 1000 个 span。
- `GET /codex-assistant/api/v2/stream`：WebSocket auth/subscribe。
- Android 不登记云端推送令牌；前台服务直接使用现有 WebSocket 接收事件并生成本地通知。
