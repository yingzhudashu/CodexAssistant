# 文档索引

文档描述当前工作树，发布状态以发布说明为准。先阅读架构和前端合同，再按验收矩阵验证；运行截图与性能原始报告属于可重建的本地产物。

|文档|用途|
|---|---|
|[架构](architecture.zh-CN.md)|职责、数据所有权、故障与资源边界|
|[前端设计](frontend-design.zh-CN.md)|逐页字段、操作、布局和恢复合同|
|[协议](protocol.zh-CN.md)|字段、状态、消息、时间与严格校验|
|[消息发送](desktop-message-routing.zh-CN.md)|Desktop 通道、回执语义与所有权|
|[Android 网络恢复](android-network-recovery.zh-CN.md)|连接状态机、生命周期、超时与测试|
|[Trace](trace.zh-CN.md)|父子链路、批量上传、安全规则和查询|
|[性能](performance.zh-CN.md)|优化设计、目标、测量口径与限制|
|[安全](security.zh-CN.md)|凭据、信任边界、脱敏与发布材料|
|[运维](operations.zh-CN.md)|配置、故障定位、备份和恢复|
|[发布](release.zh-CN.md)|版本、客户端升级指引、构建、签名、清单与回滚|
|[验收](acceptance.zh-CN.md)|当前验证结果与未覆盖范围|
|[部署模板](../deploy/README.md)|systemd、Nginx 与目录约定|
|[验收脚本](../scripts/acceptance/README.md)|隔离环境和可重复执行命令|

前端设计源为 [spec.json](frontend-design/spec.json)，运行 `python docs/frontend-design/render.py` 生成 Markdown、HTML 和 SVG；禁止只修改生成的 Markdown。`npm run check:docs` 递归核对文档链接和源码版本，`npm run check:design` 对照严格协议，`python docs/frontend-design/validate.py` 核对图稿和来源文件。
