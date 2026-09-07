# 安全与脱敏

桌面 Token 使用 Electron `safeStorage` 加密保存，Android Token 使用 Android Keystore AES-GCM。生产服务只接受 HTTPS 代理后的公网请求；桌面端仅允许 HTTPS，HTTP 只允许本机回环地址。

离开桌面端前，脱敏器会移除 Windows/Unix 绝对路径、Bearer/API key/token/secret/password 样式和常见 JWT、GitHub、Google key 形状；标题和计划标题限制长度并折叠换行。服务端日志和 trace 属性再次限制为路由、状态码和计数。

不上传完整对话、文件内容、命令正文、命令输出、隐藏推理和绝对工作区路径。若发现脱敏规则误报，应增加明确测试后再修改协议，不在运行时提供旁路开关。
