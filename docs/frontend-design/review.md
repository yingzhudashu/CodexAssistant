# CodexAssistant · Final 1.0 审查记录

审查基线：2026-09-09；工作区代码（包含未提交变更），源文件哈希见 [source-baseline.json](source-baseline.json)。

## 文档与原稿的差异

原稿的任务状态缺少paused/usage_limited/budget_limited，误把离线当作任务终态；现已按协议完整列举。回合摘要实际每页20，协议limit最大50，禁止写“每页100条完整会话”。旧图的三色窗口按钮、重复Step占位图全部废弃。

现有能力证据：renderer/app.js已有任务过滤、task.detail、task.send和更新；monitor.ts已有resume/start/steer；Android TaskRepository已有detail/send。目标视觉是重新排版，不得丢掉消息发送。

设计差额（实现验收的必要条件，不是本次已完成代码）：服务端当前pendingRequests在收到首条result即删除，桌面通知把包含completed的方法都当作终态；需要只在目标turn终态后结束路由，并区分item完成。严格按threadId+requestId归并；同一线程一次只允许一个在途发送。重连期间不得重发。UI目标新增搜索、独立设置、详情规范化和表单错误反馈；它们是本地表现变更，不假设已有服务端搜索/未读/批量删除接口。

## 验证方法

- 对照每页source所指源码、客户端操作和协议schema核对字段、枚举、权限与事件；每个页面和动作都有固定ID。
- SVG使用真实字段/示例/控件名；前置、处理中、成功、失败分支分别绘制；旧Step占位框和错误状态图不再作为交付。
- 使用Microsoft Edge headless逐张渲染SVG并检测文本是否越出viewBox；完整HTML的图片全部加载；检查所有相对链接。
- 视觉抽样包括登录、任务/对话、详情/审批、平板与状态图；系统窗框按Windows/Android分别处理。
- 只做文档与图稿核验，没有运行产品全套测试，没有改变产品代码。实际实现后仍须执行主文档§7发布门槛。

## 覆盖注册

本版注册13个界面/状态页面，29个独立动作合同。主文档逐页嵌入所有布局与状态图。每个动作遵循G01–G16，失败不静默重放写入。

## 来源绑定

|源文件|覆盖页面|
|---|---|
|`android/app/src/main/java/site/codexassistant/CodexScreen.kt`|CA-09, CA-10, CA-13|
|`apps/desktop/src/desktop-config.ts`|CA-01|
|`apps/desktop/src/main.ts`|CA-08, CA-11|
|`apps/desktop/src/monitor.ts`|CA-05, CA-06, CA-12|
|`apps/desktop/src/renderer/app.js`|CA-02, CA-03, CA-04|
|`apps/server/src/app.ts`|CA-07|
|`packages/protocol/src/index.ts`|协议/全局规范|

## 最终静态验收结果

- 页面：13；动作：29；SVG：57。
- 全部SVG解析、Edge加载、文本viewBox边界检查通过；完整HTML图片加载通过；相对文件链接、页面ID、Markdown表格列数和最终图稿引用检查通过。
- 项目名称隔离检查通过；未保存密钥或调用外部图片API；旧占位图已移除。
- 浅色正文对比度16.29:1；辅助文字≥5.75:1；主按钮白字≥7.03:1；控件边界3.54:1。
- 视觉抽样见[复核拼图](review-preview.png)；机器检查明细见[validation.json](validation.json)。人工抽样不替代实现后的逐屏真机验收。


## 冻结前一致性复核

- 修正 Markdown 表格行之间的空行，HTML 与 Markdown 都按连续多行表格显示；独立检查 HTML 表格行数和页内锚点。
- 每个动作新增执行类别及唯一ID：本地动作、本机/系统调用、远端读取、远端写入。复制、退出账户和本地设置不再等待服务端业务回执；读取失败重试与写入结果未知分别处理。
- 明确离线本地保存、丢弃草稿确认、删除确认、菜单键盘和触控规则；补充 Windows/Android 确认层及六类恢复状态图。
- 按页面核对桌面及 Android 导航归属并同步图中高亮；明确认证页不显示业务导航、Windows临时详情保留来源导航；Android二级页隐藏一级导航（2026-09-10修订）。
- 固定深色按钮背景与白字值，使用明确的 sRGB 叠色计算 hover/pressed；移除未定义的动态色开关。
- 保存可重复执行的 [validate.py](validate.py)，覆盖源码哈希、页面/动作/图稿引用、表格、HTML锚点、图片加载及SVG文字边界。运行 `python docs/frontend-design/validate.py` 重新检查。

本记录对设计文档和静态图稿负责；没有将静态检查等同于产品功能已完成。每个目标行为仍须按对应事件ID在开发后的客户端验收。

交付文件摘要见 [artifact-manifest.json](artifact-manifest.json)；其 SHA-256 覆盖主文档、HTML、规格、生成器、验证脚本、审查记录、源码基线及最终SVG，便于识别后续变更。


## 2026-09-10 客户端修订复核

本轮范围为Android二级页导航/返回链、Windows本机发送就绪判定及ICO托盘、两端九状态标签与筛选。上文2026-09-09记录保留为历史，源码基线更新到本轮工作区。57幅结构图已重绘；结构图不代表真机截图。

Windows本机发送通过renderer回归和Electron smoke检查；Android导航规则通过单元测试，尚未完成物理手机系统返回键/输入法验收。Windows托盘资源经Electron解码为非空，仍需安装后的实际系统托盘显示验收。云端首条result结束路由的既有差额不在本轮修复范围。
