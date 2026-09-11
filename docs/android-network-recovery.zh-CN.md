# Android 后台同步与网络恢复设计

状态：已实现并完成模拟器验收，待发布 Android 2.0.12（versionCode 15）。本修订针对 Android 2.0.11 的后台返回离线问题；Windows 2.0.13、业务协议 `codex-assistant.v3` 和 SQLite schema 6 不变。本文是连接恢复的详细合同，协议字段以 protocol.zh-CN.md 为准。

## 问题证据与目标

代码确认：MainActivity.onStart 只启动前台服务，已有服务的 onStartCommand 不唤醒连接；SyncCoordinator.start 在收集 Job 活跃时直接返回，不能证明 socket 可用；TaskRepository 没有默认网络回调、认证/订阅期限或完整的旧连接失效保护，onOpen 过早重置退避计数。回调与重连协程共同修改状态，尚未保证串行。用户现象未在设备上复现，不能将上述缺口认定为其唯一现场根因。

目标是网络恢复和回到前台后主动恢复真实订阅，保留缓存及草稿。前台服务不等于网络永不断开。沿用 Android ConnectivityManager、现有 OkHttp 4.12.0 与 kotlinx.coroutines；不增加生产依赖、配置层、应用消息队列、轮询保活任务或后台自启绕行。

## 职责和生命周期

MainActivity.onStart 向进程唯一 SyncCoordinator 报告可见并请求启动 SyncForegroundService；onStop 报告不可见。Coordinator 记录界面可见与服务存活两个所有者：至少一个存在且有凭据时维持唯一 Repository 收集任务；两者都消失才停止连接。服务 onCreate/onStartCommand 幂等注册所有者，onDestroy 只释放自己的所有权，不得停止仍在前台使用的连接。重复 start、旋转和配置保存不得创建第二条有效订阅。

旋转等 isChangingConfigurations=true 的 onStop 不记为真正进入后台；后续 onStart 只刷新可见所有者，不强制重连。第一次启动没有后台遗留连接，只执行首次拨号。服务所有者按服务实例标识管理，旧实例的迟到销毁不能移除新实例；不增加持久化所有者记录。

Android 15 dataSync 超时必须按系统期限 stopSelf；不会从超时回调或网络回调重新启动前台服务。Activity 可见时负责申请前台服务；系统拒绝启动时，界面仍可使用同一个 Coordinator 同步，但说明后台同步暂不可用。后台服务恢复属于操作系统许可范围，不能承诺被强行停止后自启或全天在线。进程被杀后由 START_STICKY 或用户重新打开按系统规则恢复。

Coordinator 运行期间注册一个 registerDefaultNetworkCallback，并声明 ACCESS_NETWORK_STATE；停止时注销。回调只提供连接恢复信号，不能直接创建 socket。使用默认网络标识去重：网络丢失只处理当前默认网络，旧网络的 onLost 不得取消替代网络。能力回调无实际变化不触发重复连接。注册后的首次状态也须处理，防止错过启动前已有网络。

不把 NET_CAPABILITY_VALIDATED 当作连通性硬门：局域网、自建站点仍可尝试连接。系统存在默认网络只代表可以尝试，真实服务可达以认证和 snapshot 为准；没有默认网络时显示等待网络，暂停周期拨号。Activity 回前台时重新读取当前默认网络，覆盖后台暂停期间错过的信号。

## 唯一连接和超时

Repository 负责 socket、状态、当前连接代次、重试 Job 和握手期限；所有网络回调、生命周期信号、socket 回调和计时器事件在同一串行状态处理入口执行。连接代次只是内存标识，不进入线上协议，不添加通用框架。

| 触发 | 处理 |
|---|---|
| 首次启动或服务重建 | 有默认网络及凭据时建立连接；无网络则等待回调 |
| 真正从后台返回前台 | 已断开时取消退避立即拨号；已连接时取消原 socket 并重建一次，以新认证和快照核实后台遗留连接；正在有效期限内握手时复用该尝试 |
| 默认网络恢复或切换 | 取消旧 socket 和退避，立即尝试新网络；重复同网络回调不另建连接 |
| 当前默认网络丢失 | 立即撤销可发送状态、取消 socket 和计时器，保留缓存并等待网络 |
| 短暂传输失败、服务关闭、握手超时 | 有网络时按 1、2、3、4、5、6 秒退避，上限 6 秒；只保留一个重试任务；收到 snapshot 才重置次数 |
| auth_failed / protocol_error | 不因前台或网络信号自动重试；仅用户保存有效配置后重建 |
| 停止、配置更换 | 先使旧代次失效，再 cancel 旧 socket/计时器；旧回调不得修改 cursor、缓存、连接状态或发起重试 |

重建前同步撤销 activeSocket 和 connected，再取消旧连接，避免业务消息进入旧 socket 队列。只在当前代次收到有效 snapshot 后开放发送；onOpen 只进入 authenticating。TCP/TLS/升级沿用 OkHttp 10 秒连接超时；另从创建连接起设总握手上限 25 秒，并从 onOpen 起设认证至首个 snapshot 的 15 秒期限，以先到者为准。计时使用 SystemClock.elapsedRealtime，回到前台先检查是否已经超期。重试时间戳 retryAtEpochMs 仅用于 UI 显示，不以墙钟变化延长期限。

继续使用 OkHttp 原生 30 秒 ping/pong 检测，没有额外业务心跳或永远持有的 WakeLock。系统允许线程运行时，通常在两个 ping 周期内发现无 pong 的连接；Doze/系统冻结期间不承诺该时限。默认网络事件或回到前台优先触发恢复，无须等待 ping。

Trace 上传必须有独立的有限调用超时（15 秒），不得用无限 readTimeout 的诊断 HTTP 阻塞关闭或接管连接；只记录恢复触发类型、代次、阶段、耗时和错误分类，不写 Token、消息正文、网络 SSID/IP 或服务凭据。使用现有 OkHttp 配置派生客户端即可。

## 服务端、恢复数据和消息边界

沿用现有 auth → authenticated → subscribe(after=cursor) → event 回放 → snapshot → 待答请求及交互终态回放。服务端无需新字段、重复订阅能力或业务 ping；新 socket 重新鉴权。仍最多回放 500 条事件，以最新完整快照校准。仅当前连接的有效事件/快照可保存游标，snapshot 可以纠正高于服务端的旧游标。

同一配置重连保留当前进程任务缓存、游标、草稿和已有展示结果；握手期间标为上次同步，不把列表闪成空。首个快照替换任务并重新建立待答集合；抑制恢复回放产生的历史任务通知。配置更换才清空旧服务数据，失效回调不得混入新配置。

任何连接重建均不自动重发 send、detail 或 interaction.submit。服务端对已断开的手机请求不保证后续结果重放；未确认的普通消息显示“结果尚未确认，请读取回合摘要核实”，保留草稿，由用户决定是否再次发送。已接受回合继续执行，断线不取消 Codex 回合。detail 中断结束加载并允许手动重读；交互按原 requestId 的恢复结果处理，未知写结果不显示成功。

## 界面和通知

保留既有 connectionStatus 枚举，不添加兼容映射；connected 只由当前订阅快照证明。设置、任务页和常驻通知共用状态文案，不再把所有异常都称为“网络离线”。

为准确展示原因，TaskState 仅新增本机字段 networkAvailable: Boolean?（null=尚未读取，false=无默认网络，true=存在默认网络）与 backgroundSyncStatus: String（stopped / running / unavailable）。前者来自 Coordinator 的默认网络观测，后者来自服务注册/销毁或平台拒绝启动；启动申请尚未回调时保留 stopped。Repository 不覆盖后台服务状态。字段不序列化到 WebSocket、服务端数据库、任务快照或通知正文，既有业务模型不变。error 保留用户可读的错误原因，状态判断不能依赖匹配中文文案。

| 状态 | 展示与操作 |
|---|---|
| connecting / authenticating / subscribing | 连接中 / 认证中 / 同步中；轻量进度，保留缓存；禁用远端发送 |
| reconnecting | 正在恢复连接，显示次数及下一次尝试时间；不弹重复 Toast |
| offline 且系统无默认网络 | 等待网络恢复；保留缓存，无重试倒计时 |
| offline 且服务已停止 | 同步已停止；说明回到应用恢复，不伪装网络故障 |
| auth_failed / protocol_error / not_configured | 认证失败 / 协议错误 / 未配置；给出编辑连接入口，不宣称自动重连 |
| connected | 已连接，恢复发送；显示最近实际同步时间，不将回前台时间冒充同步时间 |

后台服务不可用的说明与网络状态独立展示，例如“后台同步暂不可用，当前页面仍可同步”；不得映射为 auth_failed。复用既有系统通知设置入口，不自动请求电池豁免。点击后不假定用户已授权；回到前台重新读取可查询权限。保持 48dp 点击目标，200% 字号可滚动。无永久联网保证、强制白名单或后台无限重启。

## 实现和验收顺序

先实现串行的唯一连接恢复和实际 WebSocket 回归，再接入 Activity/服务所有权与默认网络回调，最后统一状态和通知文案。删除旧 reconnectScheduled/分散回调路径，以新机制替换，不保留双重重连策略。无协议升级、migration 或 fallback。

| 场景 | 通过条件 |
|---|---|
| 正常前后台切换 20 次 | 每次只保留一个有效订阅、一条常驻通知；正常测试网络返回前台至 snapshot ≤5秒；保留页面、缓存和草稿 |
| 后台网络断开再恢复，含 Wi-Fi/移动网络切换 | 收到恢复信号后 ≤1秒发起连接；正常测试网络 ≤5秒收到快照；旧网络 onLost 不打断新连接 |
| TCP 可连接但无认证或快照 | 达到上述握手期限后取消并退避；不无限停在认证/同步中 |
| 半开连接、后台冻结后恢复 | 恢复前台立即重建或取消已超时握手，旧回调不把新状态改离线 |
| 重复前台信号、连续网络回调、迟到 onFailure | 有效 socket/重试各最多一个，连接代次保护可由确定性测试验证 |
| 无网络、401/认证拒绝、协议不符 | 无网络停止拨号；永久错误不随回前台/网络事件重试；修正配置恢复 |
| 超时停止服务与 Activity 返回交错 | 旧服务销毁不关闭前台连接；无法启动服务有明确说明；不从后台越权拉起 |
| 恢复途中发送与未确认写操作 | 仅快照后允许新发送；旧请求不自动重放，不丢草稿，不伪造成功 |
| 配置切换、旧游标、超过500条变化 | 旧连接不能写新状态；完整快照校准；不为恢复历史广播重复通知 |

上述 1/5 秒为可控网络和正常服务下的验收目标，不是互联网 SLA。故障恢复以相同条件重复测试并记录每次耗时、连接数和失败次数，不以一次成功替代整个场景。

测试优先使用已有 JUnit/协程及本地 Fastify/WebSocket 夹具；若需要模拟 OkHttp 握手，允许加入同版本 MockWebServer 测试依赖，不手写 WebSocket 协议服务。模拟器覆盖断网、前后台、服务超时、进程重建；真机锁屏、声音、厂商电池策略、真实 Doze 和移动网络切换仍按用户已确认的无真机限制保留，不能记为通过。

## 参考模式

- Android 默认网络回调及竞态说明：https://developer.android.com/develop/connectivity/network-ops/reading-network-state
- Android 前台服务超时和停止要求：https://developer.android.com/develop/background-work/services/fgs/timeout
- OkHttp 原生 pingInterval：https://square.github.io/okhttp/4.x/okhttp/okhttp3/-ok-http-client/-builder/ping-interval/

实现使用 Android ConnectivityManager、OkHttp 4.12.0 和 kotlinx.coroutines，未增加生产依赖或厂商保活库。模拟器验收完成 20 次前后台重连、3 次断网恢复和一次服务端主动断开；真机锁屏、Doze、移动网络与厂商电池策略仍是明确限制，不以模拟器结果替代。
