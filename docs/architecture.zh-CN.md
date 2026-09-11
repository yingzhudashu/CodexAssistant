# 架构说明

## Android 网络恢复修订（待确认）

本轮设计见 [Android 后台同步与网络恢复](android-network-recovery.zh-CN.md)。这是待确认的目标行为，尚未修改或发布实现。沿用进程唯一 SyncCoordinator 与 TaskRepository，增加 Activity/服务生命周期所有权、默认网络恢复信号、串行连接状态和失效代次保护。前台服务退出不能关闭仍由可见界面使用的连接；恢复网络不在后台自行拉起服务。连接的总握手期限为25秒，onOpen 后至 snapshot 为15秒，以先到者为准；只在 snapshot 后开放发送。服务端仍使用原 auth/subscribe/回放/快照链路，协议和 schema 不变。

## 2026-09-10 前端交互修订对应的实现约束

- 展示层只消费协议字段并进行明确映射：连接状态、任务状态、freshness、回合状态和本机就绪状态分开建模，缺失字段返回“暂未提供”，不把内部枚举直接拼入用户文案。
- Windows renderer 的消息格式化必须在本地完成且先转义原文；表格、代码块、列表和行内公式只能生成安全的展示节点，不新增远程接口或上传正文。布局断点优先保证详情正文和输入区的可用宽高。

- Android 一级导航只存在于任务首页和设置首页。详情页、设置二级页进入独立页面栈；系统返回先退出输入法/弹层，再按二级页 → 设置首页 → 任务首页逐级返回。
- Windows 本机控制与云端同步分别建模：`workstation.status.ready` 由 app-server initialize/initialized 握手及退出/停止事件决定；`sync.status` 仅表示采集/上传循环。renderer 使用前者判断本机 IPC 发送，不再把 syncing/offline 当作本机不可用。`task.send` 等待唯一启动 Promise；已知本工作站的进行中回合直接 `turn/steer`，不再调用 `thread/resume` 争夺同一写入权；非活动会话才 resume 后 start。Android 仍经云端 WebSocket 转发，不改变服务端鉴权和工作站不可达回执。
- Windows 托盘资源必须从 `apps/desktop/assets/tray.ico` 读取并通过 `nativeImage.createFromPath` 创建；构建时校验文件存在且为有效 ICO，运行时不得回退到透明占位图或 SVG data URL。
- 任务状态唯一来源是协议 `TaskStatusSchema` 的四状态：running、needs_action、completed、failed。Android、Windows 的标签、筛选项、通知摘要和空态均由同一固定映射派生，连接状态和 freshness 独立展示。

## 数据链路

`codex app-server` 通过 stdio 输出 JSON-RPC。Electron 主进程启动并管理子进程，每两秒扫描线程元数据，并增量读取 thread/list 返回的本机 rollout 路径中的生命周期事件；按 Goal、最近 Turn、线程运行态、计划和动作类型归一化成任务快照。脱敏后的事件写入本地 outbox，再经 HTTPS `POST /codex-assistant/api/v3/events` 发送到服务端。

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

冷启动从文件尾向前查找，随后只读新增字节；每线程每轮读取预算为 2 MiB，未完整写入的行暂存，单条未完成记录上限为 1 MiB。文件被替换、缩短或路径变化时重建游标。读取失败或尚未追上文件时按缓存证据重新投影并标记 stale，无缓存时标记 unavailable；过期的运行推断不会永久冻结在缓存里。文件路径与正文不进入网络载荷或 trace。

历史 `task_started` 不能单独证明当前仍在执行。仅当官方运行态为 `notLoaded` 且最近回合尚未结束时，先使用 rollout 文件最近写入时间作为活动证据；普通静默回合达到 30 分钟后显示 needs_action/stale 和 `ACTIVE_EVIDENCE_EXPIRED`（运行状态待确认）。如果 `thread/items/list` 同时确认当前回合仍有 `inProgress` 操作，则在 6 小时内继续显示 running/stale，避免长命令、MCP 调用或协作任务被过早判空闲。历史 latestTurn 仍保留 inProgress，不能伪造 completed、interrupted 或 failed；Goal 的非 active 状态仍优先。完成和中止事件不需要续期，官方明确报告的运行/等待状态不受此窗口影响。

文件写入和 `inProgress` 操作都是有界证据，不是进程存活证明：无进行中操作的静默回合在 30 分钟后进入待确认；存在进行中操作的回合最多保留 6 小时，避免历史未完成标记永久显示运行中。无法观测的审批等待仍可能进入待确认；外部程序修改文件时间可能使证据重新变新。异常未来时间超过本机时间一秒视为无效，亚秒差允许通过以适应 Windows 文件时间精度。这条链路无法观测另一个进程的审批等待标志，也不能仅凭时间证明任务完成。详细等待状态仍依赖官方状态或 Goal，不能宣称所有运行细节都能从本机事件恢复。

## 运行中的约束

桌面详情缓存按线程元数据、官方状态、计划修订及收到的 Turn 通知失效；缓存只保存未投影的官方基础快照及最近生命周期证据，每轮重新计算展示状态。文件读取失败时仍检查已缓存证据是否过期，不能永久冻结旧 active。生命周期文件独立增量读取，避免元数据未变化时漏掉开始/终止事件；仅文件时间续期不改变快照时间或产生重复上传。官方通知仅来自监控自己启动的 app-server，不代表已订阅 Codex 桌面进程。轮询本身有重入保护，耗时超过两秒不会同时启动第二轮。

Android 使用进程内 SyncCoordinator 统一入口；Compose 订阅 StateFlow，前台服务维护生命周期并生成通知。当前连接状态和重试计数来自 TaskRepository，首次 snapshot 前不显示已连接。快速重配、慢消费者和多设备任务 ID 冲突仍需要专门压力验收，不能仅凭模块划分承诺所有竞态已消除。

服务端按设备与任务的复合键保存数据，但 Android reducer 与通知使用 task.id 去重，尚不能保证多个采集设备报告同一任务 ID 时的正确合并。客户端连接状态也不是业务状态：桌面上传失败后保留 outbox 并退避，但当前轮询仍可能结束为 connected；以服务端和手机收到的快照确认上传结果。

## 2026-09-10 IME 实现约束

Android 仅允许外层会话详情消费 IME Insets，子控件不得重复 padding；协议和发送语义保持不变。

## 2026-09-10 状态归一化与 Android 页面栈

服务端继续返回协议原始状态，客户端直接消费 running、needs_action、completed、failed 四类展示状态；本轮统一升级为v3与schema=6，旧端直接拒绝。Android 详情页由页面栈管理返回，页面层级和分区由客户端渲染。


## 2026-09-10 Codex 交互请求透传（验收修订）

CodexAssistant 是 Codex 的移动伴侣，不重新实现 Codex 能力。Windows 工作站独占官方 `codex app-server` 进程；Android 通过现有服务端 WebSocket 中转。工作站收到 app-server 的结构化交互请求后，按 `requestId + threadId` 转发给服务端，服务端广播给已认证客户端；客户端提交的选择沿相同路径返回工作站，再由工作站提交给 app-server。

交互请求字段、官方方法映射和限制以 [协议说明](protocol.zh-CN.md) 的“Codex 交互请求合同”为唯一规范。`interactions.ts` 负责方法转换与回答校验；`Monitor` 负责请求所有权、生命周期、本机 IPC 与远端通道；服务端仅鉴权、关联与幂等。Android `InteractionCard` 和 Windows 交互表单一次提交所有问题，不持久化答案。

Windows `interactions.get` 与 `interaction.submit` 是本机 IPC，使用与 Android 相同的 Monitor 入口；终态结果最多保留1000项。官方进程退出或回合完成触发过期，手机断线不执行回答。工作站连接恢复后重新发布尚未解决的请求。服务端重启无法证明历史提交结果，只返回 expired，不自动重发。

普通消息只串行同线程短暂的 RPC 提交，不等待回合结束。工作站先读取自己已缓存的当前 turn：其为 `inProgress` 时直接调用官方 `turn/steer`；没有活动 turn 时才调用 `thread/resume`，并在 resume 返回活动 turn 时改为 steer，否则调用 `turn/start`。这样本工作站连续手机消息进入 Codex 原生 steer，不会因重复 resume 触发单写入者冲突。CodexAssistant 不建立业务队列或消息审批。

`thread/resume` 返回 `already has an active writer` 表示写入权属于另一 Codex 实例，不能用本地重试、换 turn 或伪造队列接管。工作站将该原始错误转换为稳定的脱敏用户提示“此会话正由另一 Codex 实例处理，手机无法接管。请在该 Codex 实例中继续；其结束后可重新发送。”并关联原 requestId。Android 保留草稿、结束本次发送；只有用户在确认原会话结束后再次点击才会创建新 requestId。独立启动的 app-server 无法响应另一 Codex 桌面进程拥有的交互；此能力未被本轮实现或宣称支持。

Android 设置使用独立 SettingsPage 模块：连接摘要、设备偏好分组、分区说明、≥48dp目标、居中最大720dp。主题立即应用并保存；连接编辑使用原有安全存储和未保存确认；交互秘密只驻留内存。

Android 常驻同步通知的进行中任务计数仅统计 status=running；待确认、已完成、失败均不计入。

退出或替换连接时，Windows 停止新轮询和新消息提交，等待正在上传及已开始的短 RPC 收尾后关闭 app-server、保存队列；避免并发写同一 outbox 临时文件。未创建 Monitor 时仍允许正常退出。
