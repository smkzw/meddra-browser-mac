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

GitHub 发行包使用原生窗口、WKWebView、NSOpenPanel 与内置 Python。App Store 审核候选仍需验证沙盒中 Python 子进程的签名、继承权限和文件访问。当前没有安全作用域书签或把用户授权传给沙盒子进程的实现。GitHub 包的功能验收与 Mac App Store 审核分开。

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
./scripts/upload_app_store_pkg.sh build/app-store/MedDRA\ Browser-版本号-构建号.pkg
```

不要把 Apple ID 密码写入脚本或仓库。这里使用的是 app-specific password。

### 阶段 5：沙盒和提交验证

1. 按 Apple 要求为 Python 子进程及依赖单独签名，验证沙盒权限继承。
2. 实现安全作用域书签及词典数据的沙盒读取流程。
3. 用安装后的签名包验证首启、词典选择、重启、查询、导出、退出。
4. 核对 provisioning profile、Bundle ID、版本号与 App Store Connect，再用 Apple 工具验证待提交包。

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
