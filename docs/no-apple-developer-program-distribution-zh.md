# GitHub ZIP 分发

GitHub Release 提供通用 Mac App 与便携包。Mac App 采用临时本地签名，两个运行时均随包分发。Developer ID 签名、Apple 公证及 Mac App Store 审核需使用相应的 Apple 开发者账号和证书。

## 打包

在 macOS 上安装 Xcode 或其命令行工具、Node.js 22.12+、Python 3.12+ 和 `uv`，然后运行：

```bash
(cd frontend && npm ci)
./scripts/build_free_release.sh
```

将 `build/meddra-browser-mac-app.zip`、`build/meddra-browser-portable.zip` 与 `build/SHA256SUMS.txt` 一同发布。发布包仅含软件、运行时和第三方许可，词典原始文件、缓存和用户文件由用户本地管理。

## 首次打开

1. 下载并完整解压。在 Mac 上将 App 拖到「应用程序」；便携版放到可写目录。
2. 先尝试打开。若 macOS 无法验证开发者，在确认下载来源与文件 SHA-256 后，按「系统设置 → 隐私与安全性 → 仍要打开」处理。受管设备使用 IT 允许的分发方式。见 [Apple 支持](https://support.apple.com/zh-cn/102445)。
3. 从工作台选择已获授权的 MedDRA ASCII 词典目录，等待索引完成。首次使用和后续使用均可离线。
4. Mac App 可通过菜单查看启动日志。便携版启动窗口给出本地地址与错误详情。若发现包内文件缺失，请重新下载完整压缩包。

便携版 Windows 入口面向 x64 Windows 10/11。本机策略拦截脚本时，使用所在组织认可的安装方式。压缩包需要完整解压，直接从 ZIP 内打开启动文件会缺少同目录的运行时。

关闭 Mac App 窗口会退出本地服务。在便携版点击「退出便携版」或在启动窗口按 `Ctrl+C` 可关闭服务。退出后可再次双击启动。
