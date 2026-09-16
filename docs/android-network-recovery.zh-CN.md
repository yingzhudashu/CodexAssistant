# Android 同步与网络恢复合同

实现位于 SyncCoordinator、TaskRepository、MainActivity 和 SyncForegroundService，协议仍是 v3。该文档描述当前代码行为，历史缺陷与阶段性审批记录不作为现状。

## 所有权

Application 创建唯一 Coordinator。Activity.onStart 注册可见并申请前台服务，onStop 释放可见；旋转不视为真正进入后台。服务按实例注册/销毁，旧实例迟到销毁不能解除新所有者。至少一个所有者存在且有凭据时维持唯一 Repository/收集任务；全部退出才关闭。

Coordinator 注册一个默认网络回调，停止时注销。网络标识去重，旧网络 onLost 不取消新网络。存在默认网络表示可尝试，不要求系统 VALIDATED；连通性以服务鉴权和 snapshot 为准。回前台重新读取默认网络。亮屏及退出休眠广播也会主动校准连接，不等待默认网络再次变化；停止时注销网络回调和广播。

## 状态机

|触发|处理|
|---|---|
|初次启动|有网络及凭据则 connecting，否则等待网络/配置|
|onOpen|authenticating，发送 auth；尚不可业务发送|
|authenticated|subscribing，携带 cursor 订阅|
|snapshot|替换并排序快照、校准 cursor、connected、清重试计数|
|断网/关闭/传输错误|撤销旧代次，取消 socket；有网络按 1–6 秒退避，无网络暂停|
|真正回前台|已连接则重建校准；已断开立即恢复；期限内握手复用|
|网络切换/手动刷新|取消旧连接与退避，重新鉴权取快照；保留已有任务|
|auth_failed/protocol_error|永久错误，不因网络/前台信号重复拨号；重新保存配置解除|
|停止/重配|先失效旧代次，再取消 socket/Job/HTTP；旧回调不能写状态|

OkHttp connectTimeout=10 秒、pingInterval=15 秒，复用OkHttp的ping/pong检测半开连接；从拨号起总握手 25 秒，onOpen 后到 snapshot 15 秒，取先到期限。期限使用 elapsedRealtime，UI 的 retryAtEpochMs 只用于显示。前台服务不保证网络永不断开，Doze/系统冻结不承诺固定恢复时延。

## 数据和写入

回放最多 500 条（受服务发送预算限制），完整 snapshot 校准；重复序号忽略。只在当前连接接收有效事件/快照时保存游标。首次快照只建立通知基线；重连回放期间不逐条提醒，收到最终快照后与断线前基线比较，每个任务仅补发最新变化。实时事件在Repository内记录通知变化，不依赖UI是否及时收集状态。

TaskRepository 回调在同一锁内串行化；callbackFlow/StateFlow 可合并中间状态，普通回执按 requestId 累积到最多 1000 条，避免慢 UI 丢回执。交互终态同样有界。详情传输缓存最近 20 个单页，ViewModel 仅关联在途 requestId 并管理可见分页。

任何重连均不自动重发 send、detail、interaction.submit。普通消息只在匹配 started 后清本次未编辑草稿，断开/超时保留输入并提示核实摘要。服务器控制路由期限 30 秒，Android 发送本地期限 120 秒；详情与交互等待 30 秒。交互重复提交沿同 requestId，由现存请求和终态缓存控制幂等，服务重启或过期不保证结果可查。

手动下拉刷新复用同一连接入口，isRefreshing 与 refreshError 独立展示；没有额外轮询保活任务。草稿按任务页面状态保留，返回再进入不因普通网络恢复清空；编辑连接后的旧业务数据不应混入新服务。

## Trace、通知与系统

Coordinator 和 Repository 共享 TraceLogger；连接 trace 与业务事件 trace 分离，reducer 接续事件父节点。上传合并 500ms，15 秒有限 HTTP 请求；队列及父节点索引各 100，异常不取代业务结果。

同步状态、后台服务状态和系统网络是不同字段。通知变化按任务保留最新版本，最多1000个任务，跨callbackFlow/StateFlow合并仍可读取。通知发送使用单一串行队列：同一任务待发送内容被最新状态替换，首条立即发送，随后两次系统通知调用至少间隔300ms；持续事件不会重置发送期限。常驻通知显示进行中/待确认数量，与任务通知共享发送预算，防止突发调用触发系统限速后遗留旧内容。普通进度声音最多每十秒一次；待确认、完成、失败按各自状态独立节流，首次关键状态不会被之前的普通进度提醒静音。文本始终更新。通知点击打开应用，由任务列表选择目标；没有通知直接定位任务的协议。

`android.sync.notification_post`记录通知API调用，`android.sync.notification_delivery`记录从接收状态到提交系统通知的本机耗时；与事件共用traceId。此耗时不代表系统最终展示或播放声音的时刻。

持续即时通知订阅使用specialUse前台服务，manifest声明自托管服务实时状态提醒的具体用途；删除原dataSync声明及超时处理，不把长期订阅当作一次有结束期限的数据传输。Android 14及以上传入SPECIAL_USE类型，较低API使用对应可用的startForeground重载。仍由用户打开应用启动，不通过后台循环、精确闹钟或自动重启链绕过系统限制。拒绝启动时显示后台同步不可用，可见Activity仍能拥有连接。

设置→通知显示实际电池优化状态，由用户点击“允许后台持续连接”打开系统确认；返回后重新读取授权，取消不会伪造成功。未豁免时Doze可能暂停网络。通知权限与电池优化是不同授权，厂商自启动/后台限制也需单独设置。已收到事件的通知处理持有带10秒超时的短时PARTIAL_WAKE_LOCK，队列空闲及服务销毁时释放，不持有永久CPU锁，也不宣称该锁能解除Doze网络限制。

系统通知提交后按任务及revision确认，旧确认不能删除新变化；配置代次不同的通知不会发送或确认。活动任务通知保留最近40个，为常驻和系统分组留余量，避免Android每应用通知数量上限阻止新提醒；任务数据和概览计数不受影响。进程内重连可比较断线前基线；进程被杀后没有完整任务磁盘缓存，首次快照不会把全部历史任务当成新提醒。

设计依据：[Android Doze与豁免说明](https://developer.android.google.cn/training/monitoring-device-state/doze-standby?hl=en)、[Android 15服务类型源码](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/core/java/android/content/pm/ServiceInfo.java)、[系统通知限速与数量限制](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/notification/NotificationManagerService.java)。持续连接与明确用途的前台通知服务参考[ntfy Android实现](https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/java/io/heckel/ntfy/service/SubscriberService.kt)，不照搬自动重启链。

## 验收

自动回归覆盖唯一连接、期限、永久错误、网络切换、旧回调、刷新、通知投影、150 条突发回执的慢消费者。隔离模拟器脚本覆盖 20 次前后台、3 次断网恢复、一次服务端主动关闭，核对 active=1、快照增长、writes 不增长。

通知回归覆盖StateFlow合并、首次快照静默、实时新任务、重连最终快照补报、旧revision确认、配置切换、1000项边界、连续流量不饿死发送及任务/概览共享速率。`android-notifications.py`检查实际系统通知记录、后台延迟、重连补报、40次突发事件、授予豁免后的强制休眠及CPU锁释放；结束后恢复模拟器休眠/电池设置。

正常可控网络回前台到可用状态目标 ≤5 秒，网络恢复信号后立即拨号；这是验收目标，不是任意移动网络 SLA。实际本轮结果见[验收记录](acceptance.zh-CN.md)。物理手机、厂商电池策略、真实 Doze/锁屏声音、移动网络和系统长时间冻结须另测，不能用模拟器结果代替。
