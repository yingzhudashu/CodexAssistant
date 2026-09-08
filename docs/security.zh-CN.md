# 安全与脱敏

## 凭据与连接

桌面 Token 使用 Electron safeStorage 加密保存，Android 使用 Android Keystore AES-GCM。Token 输入框使用密码显示，已保存的桌面 Token 不经 connection.get 返回 renderer；配置页仍会在内存里处理用户刚输入的 Token，不能宣称界面完全不接触凭据。

客户端应填写站点根地址并使用 HTTPS；桌面仅允许 HTTPS 或本机回环 HTTP。生产 Android 禁用明文流量，Debug 构建允许明文流量但配置表单仍限制为 HTTPS/回环 HTTP。默认 Debug 地址 10.0.2.2 不能直接通过当前表单的回环校验，开发时需使用 HTTPS 入口或 adb reverse 配合 localhost，不能把默认值当作已跑通的配置。

生产服务监听回环端口，由 Nginx 终止 TLS。所有任务和 Trace 接口都需配置 Token，health 无需鉴权。当前采用共享 bearer Token，拥有 Token 即可访问服务内任务与 Trace；没有按用户或设备实现独立权限隔离。

## 数据最小化

桌面上传标题、项目目录名、计划、状态、动作类型和时间；不上传完整对话、文件内容、命令正文/输出或隐藏推理。本机会话文件只提取开始、完成和中止事件，文件路径和原始记录不进入该生命周期结果。公开 Goal 的 objective 会转换成脱敏标题/目标字段，并非整段内容完全禁止传输。

sanitizeText 移除常见 Windows/Unix 路径、密钥样式和多余空白，再限制文本长度。这是针对常见形状的规则，不能识别所有秘密或任意业务敏感信息。修改脱敏逻辑需增加针对实际样例的测试。

服务端协议拒绝未知对象字段并限制消息大小；它不对所有正文做内容脱敏。OTel exporter 有属性名白名单，而 Trace 上传接口仅检查结构和长度。异常日志及客户端自由文本错误仍需审查，不应将未脱敏日志直接分享给第三方。

## 发布材料

Keystore、证书私钥、签名密码、访问 Token 和本地连接文件不得提交 Git。APK、EXE、数据库、构建输出和临时诊断文件也不提交，安装包通过下载服务发布。Windows 安装包当前未签名；Android 更新必须沿用同一 release keystore。修改凭据或重建客户端状态前先备份必要数据，不在日志中打印原始值。
