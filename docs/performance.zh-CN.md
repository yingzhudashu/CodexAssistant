# 性能与稳定性

自动化验收目标：服务端 ingest p95 ≤ 50 ms、任务查询 p95 ≤ 100 ms；桌面 100 个线程空闲轮询 p95 ≤ 300 ms、活跃轮询 p95 ≤ 2 s；稳定运行 30 分钟 RSS 增长 ≤ 50 MB。Android 网络恢复后 5 秒内进入重连流程，并且进程内只允许一个 WebSocket。基准命令为 `npm run perf:server`，逐请求记录 ingest 延迟并输出真实 p50/p95 JSON 结果，不写入仓库。

## 设计指标

- 桌面轮询周期：2 秒；详情 RPC 最大并发：8；单 RPC 超时：15 秒。
- 上传请求超时：10 秒；失败采用指数退避，最大 60 秒；outbox 最大 5000 条。
- 服务端 HTTP body 最大 128 KiB；WebSocket 客户端入站单消息最大 32 KiB；单次游标回放最多 500 条。
- Android 前台服务只维护一个 OkHttp WebSocket，连接超时 10 秒、30 秒 ping；cursor 持久化到 SharedPreferences，访问 Token 单独使用 Keystore 加密。Compose 界面复用进程内 `SyncCoordinator` 状态流，不重复建连。
- Android 前台服务常驻通知使用 `IMPORTANCE_LOW` 渠道；任务状态或当前步骤变化使用独立 `IMPORTANCE_DEFAULT` 渠道。通知正文只包含脱敏后的标题、状态和步骤，不包含命令、路径或输出。

## 优化点

桌面端按线程更新时间、状态、标题和计划修订做缓存；无变化线程不再调用四个详情 RPC。线程详情采用并发上限，单个线程读取失败保留有效缓存并标记 stale，无缓存则标记 unavailable，不阻塞其他线程。没有变化的任务不会生成重复事件。

Electron 构建前会清理 `apps/desktop/dist` 和 TypeScript 的增量状态，协议运行时包只保留所需编译产物。构建输出固定在 `apps/desktop/build`，避免把旧的 `win-unpacked` 递归打进安装包。发布前应记录安装包体积，异常增长直接阻断发布。

## 观测

health 接口返回进程 RSS、运行秒数、WebSocket 订阅数、事件数、任务数、trace span 数和当前游标。桌面 trace 记录轮询、RPC 和上传延迟。生产环境应定期记录 health 输出并观察 outbox 长度、HTTP 5xx 和 SQLite 文件大小。

## 压测建议

现有可重复执行的基准只有 `npm run perf:server`：在隔离临时 SQLite 中对同一任务发送 1,000 条事件，统计进程内 Fastify inject 延迟。脚本仅输出测量结果，没有针对性能阈值的自动失败断言，也不是 1,000 个并发任务或公网压测。

长期验收需另外覆盖：100/1,000 线程的 RPC 与文件读取负载、超过 500 条回放时的快照校准、慢消费者广播、连续断线重配和 30 分钟 RSS/CPU。当前项目没有自动执行这些场景的完整压力工具。关闭通知权限不等同于停止前台服务，实际后台行为取决于 Android 版本和设备电池策略。

## 基准范围

本机 `npm run perf:server` 的 1,000 条事件测试得到 ingest p95 4 ms、单次 tasks 查询 2 ms。该脚本使用进程内 Fastify inject、一个任务，不包含公网延迟，也不能证明 1,000 个任务或 30 分钟稳定性目标已达标。

服务端 Trace 在启动时及每千次写入后按接收顺序保留最新 100,000 条，清理间隔内最多多出 999 条；客户端时间不会改变保留顺序。清理不作用于 task_events/tasks，也不主动 VACUUM，因此 SQLite 已分配的磁盘空间可能保留供后续复用。十万条记录的保留、重复写入和重启清理已有回归测试。

Android 通知按同步状态流观察到的变化更新最新状态，十秒节流只限制声音。游标回放期间不提示历史变化，首次快照后才启用实时变化通知。
