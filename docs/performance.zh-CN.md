# 性能与稳定性

自动化验收目标：服务端 ingest p95 ≤ 50 ms、任务查询 p95 ≤ 100 ms；桌面 100 个线程空闲轮询 p95 ≤ 300 ms、活跃轮询 p95 ≤ 2 s；稳定运行 30 分钟 RSS 增长 ≤ 50 MB。Android 网络恢复后 5 秒内进入重连流程，并且进程内只允许一个 WebSocket。基准命令为 `npm run perf:server`，逐请求记录 ingest 延迟并输出真实 p50/p95 JSON 结果，不写入仓库。

## 设计指标

- 桌面轮询周期：2 秒；详情 RPC 最大并发：8；单 RPC 超时：15 秒。
- 上传请求超时：10 秒；失败采用指数退避，最大 60 秒；outbox 最大 5000 条。
- 服务端 HTTP body 最大 128 KiB；WebSocket 单消息最大 32 KiB；单次游标回放最多 500 条。
- Android 前台服务只维护一个 OkHttp WebSocket，连接超时 10 秒、30 秒 ping；cursor 持久化到 Keystore 保护账户对应的 SharedPreferences。Compose 界面复用进程内 `SyncCoordinator` 状态流，不重复建连。
- Android 前台服务常驻通知使用 `IMPORTANCE_LOW` 渠道；任务状态或当前步骤变化使用独立 `IMPORTANCE_DEFAULT` 渠道。通知正文只包含脱敏后的标题、状态和步骤，不包含命令、路径或输出。

## 优化点

桌面端按线程更新时间、状态、标题和计划修订做缓存；无变化线程不再调用四个详情 RPC。线程详情采用并发上限，单个线程失败只生成失败任务卡，不阻塞其他线程。没有变化的任务不会生成重复事件。

Electron 构建前会清理 `apps/desktop/dist` 和 TypeScript 的增量状态，协议运行时包只保留所需编译产物。构建输出固定在 `apps/desktop/build`，避免把旧的 `win-unpacked` 递归打进安装包。发布前应记录安装包体积，异常增长直接阻断发布。

## 观测

health 接口返回进程 RSS、运行秒数、WebSocket 订阅数、事件数、任务数、trace span 数和当前游标。桌面 trace 记录轮询、RPC 和上传延迟。生产环境应定期记录 health 输出并观察 outbox 长度、HTTP 5xx 和 SQLite 文件大小。

## 压测建议

使用 faux server 发送 1000 个任务快照，验证桌面内存稳定、无变化轮询不增长；使用 5000 条事件验证 WebSocket 回放分批；使用 `curl` 连续重复 localSequence 验证幂等。性能目标是 100 个线程扫描在 2 秒周期内完成，单个慢线程不超过 15 秒。Android 真实设备需记录服务进程 RSS、WebSocket 重连次数、CPU 唤醒和电量变化；前台服务的系统通知不可关闭，否则系统可能终止连接。
