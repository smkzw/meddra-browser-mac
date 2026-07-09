# App Store Connect 元数据草稿

## App 名称

MedDRA Browser

## 副标题

本地 MedDRA 词典浏览与编码查询

## 分类

建议主分类：Medical

备选：Productivity

## 关键词

MedDRA,医学编码,不良事件,药物警戒,临床试验,SMQ,AE,医学词典

## 简短说明

MedDRA Browser 是一个本地运行的 MedDRA ASCII 词典浏览工具，提供中文界面、术语搜索、代码查询、SOC/SMQ 层级浏览、关系树、Research Bin 和导出功能。

## 完整描述草稿

MedDRA Browser 是面向临床研究、医学编码、药物警戒和医学监查场景的本地 MedDRA 词典浏览工具。

主要功能：

- 中文界面
- 支持中文、英文、双语 MedDRA 显示
- AE/MH 名称和代码搜索
- PT、LLT、HLT、HLGT、SOC、SMQ 多层级检索
- SOC 和 SMQ 层级浏览
- 术语详情、父级/子级关系树和出现位置展示
- Research Bin 收集和导出
- 本地索引进度显示

数据与隐私：

- App 不包含 MedDRA 词典数据
- 用户需自行拥有并选择已授权的 MedDRA ASCII 词典文件夹
- 词典解析、索引和搜索均在用户 Mac 本地完成
- 不上传词典文件、搜索内容或导出内容

本工具仅用于医学术语词典浏览与编码辅助，不提供诊断、治疗、用药或临床决策建议。

## 审核备注要点

直接使用 `docs/app-store/app_review_notes.md`。

## 截图建议

至少准备以下桌面截图：

1. 主搜索界面，显示中文 UI 和搜索结果。
2. 右侧关系树，展示 SOC/HLGT/HLT/PT/LLT 父子层级。
3. SMQ 浏览界面，展示广义/狭义条目。
4. Research Bin 和导出界面。
5. 设置/选择词典文件夹界面。

截图中不要出现真实受试者信息、未授权词典目录路径或 `/Users/smkzw` 本机路径。
