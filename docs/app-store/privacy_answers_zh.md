# App Store 隐私答复建议

以下内容用于 App Store Connect 的 App Privacy 填写前准备。正式提交前仍需由账号负责人确认。

## 是否收集数据

建议选择：不收集数据。

理由：

- App 不要求用户登录。
- App 不上传 MedDRA 词典文件。
- App 不上传搜索词、Research Bin、历史记录或导出内容。
- App 不集成第三方分析、广告、崩溃上报或远程遥测 SDK。
- App 的网络通信只用于本机 `127.0.0.1` 前端与本地服务交互。

## 用户内容

不收集。

用户选择的 MedDRA ASCII 文件夹和本地索引只保存在用户电脑本地。正式 App Store 版本应保存在 App 沙盒容器中。

## 诊断数据

不收集。

当前本地日志只写入用户本机，用于用户排查本地服务启动问题，不会发送给开发者。

## 联系信息、标识符、使用数据

不收集。

## 第三方数据共享

无。

## 隐私政策页面建议内容

可以使用以下简短说明作为隐私政策基础：

> MedDRA Browser runs locally on your Mac. It does not collect, upload, sell, or share your MedDRA dictionary files, search terms, Research Bin contents, exports, or usage data. Any local indexes and settings are stored on your device. MedDRA dictionary data is not included in the app and remains governed by the user's own MedDRA license.

## 注意

如果未来加入崩溃上报、在线更新、账号系统、云同步、远程模型或使用统计，需要重新填写隐私项并更新隐私政策。
