# 没有 Apple Developer Program 时怎么分发

如果暂时不加入 Apple Developer Program，就不要走 Mac App Store 上架路线。

可以采用现在项目已经支持的分发方式：

1. Mac 用户下载 `meddra-browser-mac-app.zip`。
2. Windows 和 Mac 都可以下载 `meddra-browser-portable.zip`。
3. Windows 同事如果只是应急使用，下载 `MedDRA-Browser-Windows-Emergency-v0.1.9.zip` 这一类版本号包。

这些包都不包含 MedDRA 词典数据。使用者第一次打开后，在“设置”里选择自己有授权的 MedDRA ASCII 词典文件夹即可。

## 这条路线能做什么

- 可以把包放在 GitHub Release、网盘、内网共享盘或邮件附件里分发。
- 不需要 Apple Developer Program 账号。
- 不需要 App Store Connect。
- 不需要证书。
- 不需要用户安装 Xcode。

## 这条路线做不到什么

- 不能上传 Mac App Store。
- 不能获得 Apple 的 App Store 审核和商店搜索入口。
- 不能做 Apple Developer ID notarization。
- Mac App 不是 App Store 沙盒版，和普通下载软件一样在本机运行。
- Mac 用户首次打开时，系统可能提示“无法验证开发者”。通常需要右键点击 App，选择“打开”。
- 如果右键“打开”仍然被拦截，到“系统设置” → “隐私与安全性”，在页面底部找到这次被拦截的 App，点“仍要打开”。

## 一键构建

在项目根目录运行：

```bash
./scripts/build_free_release.sh
```

生成文件在 `build/` 目录：

```text
meddra-browser-mac-app.zip
MedDRA-Browser-Mac-v版本号.zip
meddra-browser-portable.zip
MedDRA-Browser-Windows-Emergency-v版本号.zip
```

发布前建议至少检查：

```bash
PYTHONPATH=backend python3 -m unittest discover -s backend/tests -v
npm --prefix frontend run build
```

## 给完全不懂电脑的同事怎么说

Mac：

1. 解压 `meddra-browser-mac-app.zip`。
2. 把 `MedDRA Browser Mac.app` 拖到“应用程序”。
3. 如果双击打不开，右键点它，选“打开”。
4. 打开后点“设置”里的“选择词典文件夹”。
5. 选择自己的 MedDRA 文件夹。

如果右键“打开”仍然打不开，请到“系统设置” → “隐私与安全性”里点“仍要打开”。

Windows：

1. 解压 `meddra-browser-portable.zip` 或 `MedDRA-Browser-Windows-Emergency-v版本号.zip`。
2. 双击 `【Windows】第一步：请双击我运行.bat`。
3. 等页面自动打开。如果没自动打开，再双击 `第二步：双击我开始MedDRA浏览.html`。
4. 进入后点“设置”里的“选择词典文件夹”。
5. 选择自己的 MedDRA 文件夹。

## 和 App Store 路线的关系

`docs/app-store/APP_STORE_SUBMISSION_ZH.md` 仍然保留，给以后有 Apple Developer Program 时使用。

当前预算下，建议主线使用本文件这套分发方式；App Store 脚本只作为未来预留。
