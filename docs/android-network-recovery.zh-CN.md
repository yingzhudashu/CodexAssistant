# Android 同步与网络恢复合同

实现位于 SyncCoordinator、TaskRepository、MainActivity 和 SyncForegroundService，协议仍是 v3。该文档描述当前代码行为，历史缺陷与阶段性审批记录不作为现状。

## 所有权

Application 创建唯一 Coordinator。Activity.onStart 注册可见并申请前台服务，onStop 释放可见；旋转不视为真正进入后台。服务按实例注册/销毁，旧实例迟到销毁不能解除新所有者。至少一个所有者存在且有凭据时维持唯一 Repository/收集任务；全部退出才关闭。

Coordinator 注册一个默认网络回调，停止时注销。网络标识去重，旧网络 onLost 不取消新网络。存在默认网络表示可尝试，不要求系统 VALIDATED；连通性以服务鉴权和 snapshot 为准。回前台重新读取默认网络。

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

OkHttp connectTimeout=10 秒、pingInterval=30 秒；从拨号起总握手 25 秒，onOpen 后到 snapshot 15 秒，取先到期限。期限使用 elapsedRealtime，UI 的 retryAtEpochMs 只用于显示。前台服务不保证网络永不断开，Doze/系统冻结不承诺固定恢复时延。

## 数据和写入

回放最多 500 条（受服务发送预算限制），完整 snapshot 校准；重复序号忽略。只在当前连接接收有效事件/快照时保存游标。回放阶段不触发历史变化提醒，快照后实时变化才提醒。

TaskRepository 回调在同一锁内串行化；callbackFlow/StateFlow 可合并中间状态，普通回执按 requestId 累积到最多 1000 条，避免慢 UI 丢回执。交互终态同样有界。详情传输缓存最近 20 个单页，ViewModel 仅关联在途 requestId 并管理可见分页。

任何重连均不自动重发 send、detail、interaction.submit。普通消息只在匹配 started 后清本次未编辑草稿，断开/超时保留输入并提示核实摘要。服务器控制路由期限 30 秒，Android 发送本地期限 120 秒；详情与交互等待 30 秒。交互重复提交沿同 requestId，由现存请求和终态缓存控制幂等，服务重启或过期不保证结果可查。

手动下拉刷新复用同一连接入口，isRefreshing 与 refreshError 独立展示；没有额外轮询保活任务。草稿按任务页面状态保留，返回再进入不因普通网络恢复清空；编辑连接后的旧业务数据不应混入新服务。

## Trace、通知与系统

Coordinator 和 Repository 共享 TraceLogger；连接 trace 与业务事件 trace 分离，reducer 接续事件父节点。上传合并 500ms，15 秒有限 HTTP 请求；队列及父节点索引各 100，异常不取代业务结果。

同步状态、后台服务状态和系统网络是不同字段。常驻通知去重包含连接说明，offline→认证错误也更新文本。任务通知十秒仅限制声音，不丢弃最新状态。通知点击打开应用，由任务列表选择目标；没有通知直接定位任务的协议。

系统拒绝前台服务或 dataSync 超时，显示后台同步不可用/停止；超时回调主动 stopSelf，不从后台网络回调绕过限制拉起服务。可见 Activity 仍能拥有连接。通知权限只影响可见提醒，不改 Token 状态。

## 验收

自动回归覆盖唯一连接、期限、永久错误、网络切换、旧回调、刷新、通知投影、150 条突发回执的慢消费者。隔离模拟器脚本覆盖 20 次前后台、3 次断网恢复、一次服务端主动关闭，核对 active=1、快照增长、writes 不增长。

正常可控网络回前台到可用状态目标 ≤5 秒，网络恢复信号后立即拨号；这是验收目标，不是任意移动网络 SLA。实际本轮结果见[验收记录](acceptance.zh-CN.md)。物理手机、厂商电池策略、真实 Doze/锁屏声音、移动网络和系统长时间冻结须另测，不能用模拟器结果代替。
