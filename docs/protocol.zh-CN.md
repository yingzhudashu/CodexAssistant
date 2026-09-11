# 协议说明

本轮为不兼容升级，协议版本固定为 `codex-assistant.v3`。桌面端、服务端和 Android 必须使用同一协议版本，旧版本直接拒绝。

## 事件

`IngestEvent` 包含 `deviceId`、单调递增 `localSequence`、`occurredAt`、`trace` 和 `task`。`ServerEvent` 在此基础上增加服务端 `sequence`。重复的设备序号返回 `duplicate: true`，不会再次广播。

任务快照包含标题、项目目录名、更新时间和变更时间，并严格拆分以下语义：

- `status` 是用户展示状态，Windows 与 Android 必须完全一致：`running`、`needs_action`、`completed`、`failed`。连接状态、数据新鲜度和回合状态不属于任务状态，客户端不得将它们加入任务筛选器。
- `runtimeStatus` 是官方线程运行态：`notLoaded`、`idle`、`systemError`、`active`。
- `activeFlags` 只表示 `waitingOnApproval` 或 `waitingOnUserInput`。
- `latestTurn` 表示最近回合的 `inProgress`、`completed`、`interrupted` 或 `failed`，错误只保留安全代码和脱敏摘要。
- `freshness` 表示 `fresh`、`stale` 或 `unavailable`；详情 RPC 失败时不得把缓存线程改写成失败。

当前展示状态按以下顺序决定（工作站收到的待处理交互另行覆盖为 needs_action）：

1. 官方 systemError 为 failed；官方等待标志为 needs_action。
2. 官方当前 active 为 running，历史 Turn 不能覆盖当前活动证据。
3. 最近回合 failed 为 failed；interrupted 为 needs_action。
4. Goal 的非运行状态优先；原生 Goal active 转为 running，其他未完成限制转为 needs_action。
5. inProgress 为候选 running；明确 completed 为 completed；其他为 needs_action。
6. notLoaded 的运行候选必须通过生命周期证据核验；无证据则 needs_action/unavailable，不将历史 inProgress 无限视为运行。

动作只允许 command_execution、file_change、mcp_call、agent_message，不携带正文。

上述规则用于官方基础状态。本机生命周期投影另有运行证据有效期：当 runtimeStatus 为 notLoaded、历史回合为 inProgress 且文件达到 30 分钟无写入时，没有进行中操作的回合展示 status 为 needs_action、freshness 为 stale、error.code 为 `ACTIVE_EVIDENCE_EXPIRED`；当前回合仍有 `inProgress` 操作时，在 6 小时内展示 status 为 running、freshness 为 stale 且不产生错误。Goal 的非 active 状态仍优先。latestTurn.inProgress 表示历史未结束标记，不能脱离 freshness 和当前操作状态解释为实时运行。恢复写入后重新投影；明确终止记录不会因时间过期而失效。内部 evidenceAt 和操作证据不进入协议载荷。

## WebSocket

客户端必须先发送严格的 `auth`，再发送一次 `subscribe` 和 `after` 游标。服务端响应 `authenticated`，随后发送游标后最多 500 条 `event`，最后发送包含所有当前任务的 `snapshot`。超过 500 条的中间历史不会继续分页发送，最新状态由 snapshot 校准；当前机制不能用于完整历史审计。未知字段、错误版本、错误顺序和超大消息直接关闭连接。

## HTTP

- `GET /codex-assistant/health`：无需业务 Token，返回协议版本、RSS、订阅数和数据库计数。
- `POST /codex-assistant/api/v3/events`：Bearer Token 鉴权，写入事件。
- `POST /codex-assistant/api/v3/traces/spans`：批量写入最多 100 个安全 span。
- `GET /codex-assistant/api/v3/tasks`：Bearer Token 鉴权，返回当前任务。
- `GET /codex-assistant/api/v3/traces/:traceId`：Bearer Token 鉴权，返回最多 1000 个 span。
- `GET /codex-assistant/api/v3/stream`：WebSocket auth/subscribe。
- Android 不登记云端推送令牌；前台服务直接使用现有 WebSocket 接收事件并生成本地通知。

Android 序列化启用 `encodeDefaults=true` 和 `explicitNulls=false`：auth/subscribe 的 type、protocolVersion 即使有默认值也必须发送，可选 null 字段则省略。必须收到 snapshot 才标记已连接；回放 event 不提前切换连接状态。重复序号忽略，snapshot 游标按服务端值校准。

## 时间语义

协议中的时间统一以 UTC ISO-8601 传输。Android 和 Windows 在显示时才转换到设备时区，包含年月日、时分秒和 UTC 偏移量；不得去掉 Z 后直接当作本地时间，也不固定加八小时。

`updatedAt` 是任务源数据的最近更新时间，不是扫描时间。对于由本机回合生命周期确定的展示状态，`changedAt` 是最近开始、完成或中止事件的时间，不随后续元数据更新而漂移；Goal 优先时保留归一化快照的 changedAt（当前来自线程元数据），它不是独立观测的 Goal 状态变更时间。缓存读取失败不把来源时间更新成现在。Windows 底部“最后采集”表示本次采集时间，不能代替任务发生时间。

运行证据过期属于观测新鲜度变化，不是已证实的任务终止，任务来源时间保持原值；此时不应把 changedAt 解释为任务实际停止时间。文件读取失败时，除了 freshness 变化，还会撤销已过期证据推断的 active。

## 连接状态与边界

Android 正常链路为 connecting → authenticating → subscribing → connected。断开后显示 offline/reconnecting 并按 1 至 6 秒延迟重试；not_configured 表示缺少 Token。auth_failed 与 protocol_error 为不可重试错误，保存配置后重建连接。当前没有独立的系统网络恢复回调，5 秒恢复目标尚未验证。

待确认的 Android 修订见 [网络恢复合同](android-network-recovery.zh-CN.md)：保留以上线上字段和枚举，在客户端加入网络/前台唤醒；无默认网络暂停重试，有网络按1至6秒退避，仅 snapshot 重置计数。总握手25秒、onOpen至snapshot 15秒期限以先到者为准，超时关闭后重试。auth_failed/protocol_error 不被恢复信号重置。失效连接的任何回调不写状态或游标；重连不自动重发业务写入，服务端不新增请求结果重放保证。5秒仅为正常可控网络的待测验收目标，不是已通过结论。

Windows 连接状态为 connecting/syncing/connected/offline，与 Android 状态机不同；connected 不代表待上传 outbox 已清空。TaskSnapshot 中 freshness 描述采集证据的新鲜度，不表示手机当前网络状态。

HTTP body 上限 128 KiB，WebSocket 的 128 KiB 限制作用于客户端入站消息，服务端任务快照没有按该大小分块。慢订阅者缓冲达到 256 KiB 时以 1013 关闭连接，客户端自动重连并按游标重放和接收最新快照，不能静默跳过广播。这些边界需纳入后续稳定性验收。

## 2026-09-10 客户端表示合同

任务筛选顺序与标签固定为：running/进行中、completed/已完成、failed/失败、needs_action/待确认。旧状态值删除，不提供兼容映射、migration 或 fallback。

Windows 新增仅本机 IPC `workstation.status -> { ready: boolean }`，不携带 Token 或正文。ready 来源于本机 app-server 的初始化完成状态；它与云端同步、任务业务状态相互独立。该 IPC 不新增公网 API。


## Codex 交互请求合同（验收修订）

以本机 codex-cli 0.153.4 `app-server generate-json-schema --experimental` 为官方协议证据。Windows 拥有自己启动的 app-server 请求；不能假设独立 app-server 可以应答另一个 Codex 桌面进程拥有的审批。Android 通过中转提交，Windows 本机使用同一交互处理入口。

`interaction.request` 必填 type、protocolVersion、requestId、threadId、kind、title；可选 description、questions、options、expiresAt。kind 为 single_select、multi_select、confirm、text、plan_select 或 unsupported。问题字段为 id、header、question、required、multiple、isOther、isSecret，可选 options。选项为 id、label、可选 description。问题与选项 ID 原样关联，不截断官方答案；过大或不能准确转换的请求显示 unsupported，不伪造答案。未知官方方法没有通用成功响应。

`item/tool/requestUserInput` 的所有 questions 一次提交，value 为 `{ "answers": { "问题ID": { "answers": ["答案"] } } }`。官方无多选标志时使用单选并允许文本补充。执行计划若以问题提出，沿用该模型，不根据问题文字猜测新方法。当前官方没有独立 plan_select 事件。

MCP form 模式的 string 枚举和 array 枚举分别映射单选和多选，纯 string 为文本，boolean 为是/否选项。Windows 将统一答案还原为 `{action:"accept",content:{字段:值}}`，按原始 requestedSchema 校验约束。无法准确渲染的数值、格式和嵌套表单以及 URL 模式显示 unsupported，用户可取消并在工作站使用支持该类型的客户端重新发起。

commandExecution/fileChange/requestApproval 显示命令、目录、原因或修改请求上下文，选项遵循 availableDecisions，缺省时使用该官方方法定义的 accept/decline/cancel。value 为 `{decision:"选项ID"}`，工作站把 ID 映射为官方 decision（含结构化决策）。permissions/requestApproval 只授予该请求的完整范围且 scope=turn，不增加请求以外的权限。

统一取消为 value `{cancel:true}`：用户输入返回空 answers；审批返回官方 cancel；MCP 返回 action=cancel；权限请求返回空 permissions。取消不是普通聊天消息审批。提交响应为 interaction.result，status=submitted/cancelled/expired/failed，不回显答案或秘密。failed 包含可重试错误说明，保留请求；submitted 只代表响应已写入官方管道，不代表回合已完成。

请求 ID 使用随机 UUID，官方 RPC id 与 threadId/turnId 仅由工作站保存。服务端以 requestId+threadId 校验和幂等；处理中重复提交不再次转发，终态在当前服务进程内保留最多 1000 个回执用于重连/重复提交。超出窗口或服务重启返回 expired，绝不重新执行。手机断线不会取消请求；工作站重连重新发布尚未解决请求。官方解决通知、目标回合终止和 app-server 退出使请求过期。无官方截止时间时不臆造超时，也不把无回执当作成功。

普通消息只串行同一线程的短 RPC 提交，上一条 RPC 完成即提交下一条，不等待回合结束、不建立本地任务审批或回合队列。工作站当前缓存的 turn 为 `inProgress` 时必须直接 `turn/steer`；不得先 `thread/resume`。不存在活动 turn 时才 `thread/resume`，resume 后若返回活动 turn 改用 steer，否则 `turn/start`。同一工作站的连续消息由官方 steer 接收并关联同一 turn。

`thread/resume` 的官方 `already has an active writer` 失败不是可重试传输错误：它说明另一 Codex 实例持有会话写入权。工作站必须将其转换为固定的脱敏失败提示，不回传 threadId、原始 app-server 文本或其他实例信息；不得开始新 turn、重新 resume、排入本地队列或自动重试。手机保留草稿并结束当前 requestId；用户可在原实例结束会话后手动重新提交。其他发送失败仍与其 requestId 关联。Android 连续消息保留最新请求的展示，旧回执不能清除新草稿。

筛选顺序为全部、进行中、已完成、失败、待确认。待处理交互优先于运行态；明确失败、官方当前活动、明确完成和证据过期按状态规则投影。运行证据不足归 needs_action；官方 Goal 的 active/paused/blocked 等属于输入域，转换成四种展示状态不是保留旧客户端协议。

## 发布边界

本轮唯一协议为 codex-assistant.v3，唯一 API 前缀为 /codex-assistant/api/v3；SQLite schema=6。v2 客户端和 schema=5 数据库直接拒绝；不提供旧入口、兼容字段或 migration。2026-09-10 已部署生产 v3，客户端发布 Windows 2.0.12、Android 2.0.10（versionCode 13）；旧客户端必须更新。
