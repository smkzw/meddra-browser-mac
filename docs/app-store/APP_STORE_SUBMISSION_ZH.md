# MedDRA Browser Mac App Store 上架准备说明

## 当前结论

如果没有 Apple Developer Program，不能发布到 Mac App Store。当前预算下请改用：

```text
docs/no-apple-developer-program-distribution-zh.md
```

当前仓库已经具备“App Store 候选包构建链”：

- 可以设置正式 Bundle ID、版本号、构建号。
- 可以启用 App Sandbox entitlements。
- 可以使用 `Apple Distribution` / `Mac App Distribution` / `3rd Party Mac Developer Application` 证书签名 App。
- 可以使用 `Mac Installer Distribution` / `3rd Party Mac Developer Installer` 证书生成 `.pkg`。
- 可以扫描包内是否混入 MedDRA 词典、SQLite 缓存、`pyc` 或本机路径。
- 可以准备 App Review Notes、隐私答复、App Store Connect 元数据。

但当前架构还不是正式审核就绪：

- App 仍是脚本壳启动本地 FastAPI 服务，再打开外部浏览器。
- App 依赖系统 `python3`，虽然 Python 包已随 App vendor，但 Python 解释器本身不是自包含。
- macOS 文件夹选择仍依赖后端 `osascript`，不符合 App Store 沙盒下的原生文件访问模型。
- 当前 `MEDDRA_APP_STORE_MODE=1` 候选模式会禁用 AppleScript 文件夹选择，`选择词典文件夹` 会返回候选模式不可用。因此即使签名成功，这个候选包也不是可送审的可用产品，只能用于证书/上传链路联调。
- 尚未实现安全作用域书签，因此用户选择 MedDRA 词典文件夹后的长期访问在沙盒环境中不可靠。

因此，`scripts/build_app_store_pkg.sh` 默认不会直接生成正式审核包。若只是为了证书、App Store Connect 记录、Transporter 上传链路联调，可以显式设置：

```bash
ALLOW_KNOWN_APP_STORE_BLOCKERS=1
```

## 推荐上架路线

### 阶段 1：账号和证书准备

1. 加入 Apple Developer Program。
2. 在 Certificates, Identifiers & Profiles 创建 Mac App Bundle ID。
3. 开启 App Sandbox。
4. 创建并下载：
   - App 签名证书：`Apple Distribution`、`Mac App Distribution` 或旧名称 `3rd Party Mac Developer Application`
   - 安装包签名证书：`Mac Installer Distribution` 或旧名称 `3rd Party Mac Developer Installer`
   - Mac App Store provisioning profile
5. 安装完整 Xcode，并运行：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### 阶段 2：本地候选包构建

把下面的 Bundle ID 换成你在 Apple Developer 里注册的值：

```bash
cd /Users/smkzw/Documents/指导原则及临床试验规范合集/MedDRA/meddra-browser-mac

APP_STORE_BUNDLE_ID=com.yourcompany.meddra-browser \
APP_STORE_PROVISIONING_PROFILE=/path/to/profile.provisionprofile \
ALLOW_KNOWN_APP_STORE_BLOCKERS=1 \
./scripts/build_app_store_pkg.sh
```

生成的 `.pkg` 位于：

```text
build/app-store/
```

### 阶段 3：App Store Connect 记录

在 App Store Connect 新建 macOS App：

- 名称：`MedDRA Browser`
- 主要语言：简体中文
- Bundle ID：使用阶段 1 注册的 Bundle ID
- SKU：建议 `meddra-browser-mac`
- 类别：Medical 或 Developer Tools/Medical 之间择一。更建议 Medical，但审核说明要强调它是本地词典浏览工具，不提供诊断、治疗建议或自动医学决策。
- 价格：按你的授权策略选择。若 MedDRA 授权限制外部分发，应考虑免费但要求用户自行拥有 MedDRA 词典。

### 阶段 4：上传构建

优先使用 Xcode Organizer 或 Apple Transporter。命令行可用时：

```bash
APP_STORE_APPLE_ID=your-apple-id@example.com \
APP_STORE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
./scripts/upload_app_store_pkg.sh build/app-store/MedDRA\ Browser-0.1.9-10.pkg
```

不要把 Apple ID 密码写入脚本或仓库。这里使用的是 app-specific password。

### 阶段 5：正式审核前必须完成的原生化改造

正式送审前建议完成：

1. 用 Swift/AppKit 或 SwiftUI 做原生宿主窗口。
2. 用 `WKWebView` 在 App 内显示 React 前端，而不是打开外部浏览器。
3. 后端改成随 App 签名的本地 helper，或把查询逻辑迁移到原生/嵌入式运行时。
4. 词典文件夹选择改为原生 `NSOpenPanel`。
5. 保存 security-scoped bookmark，重新打开 App 后能恢复用户授予的词典目录访问。
6. 移除 `osascript`、System Events 自动化、外部浏览器最大化逻辑。
7. 用沙盒环境完整测试：首次选择词典、重启后加载词典、索引、搜索、Research Bin 导出。

还要检查：

- `embedded.provisionprofile` 已内嵌。
- `codesign` 使用 hardened runtime。
- `productbuild` 带时间戳。
- 上传前用 Apple 工具做 validate。
- App Store Connect 类别、Bundle ID、版本号与 `Info.plist` 一致。

## App Store 审核说明建议

使用 `docs/app-store/app_review_notes.md` 作为基础。重点说明：

- App 不包含 MedDRA 词典数据。
- 用户必须自行选择其已授权的 MedDRA ASCII 词典文件夹。
- 所有词典解析、索引、搜索均在本机完成。
- App 不上传、不采集、不共享用户词典或搜索数据。
- App 不提供诊断、治疗建议或自动医学决策，只是医学术语词典浏览工具。

## 参考资料

- Apple Developer Program: https://developer.apple.com/programs/
- Apple App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple App Sandbox: https://developer.apple.com/documentation/security/app-sandbox
- App Store Connect - Add a new app: https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/
- App Store Connect - Upload builds: https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/
- App privacy details: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/
