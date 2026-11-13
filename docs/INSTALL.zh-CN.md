# 安装、升级与回退 Windows x64 内测版

简体中文 · [English](INSTALL.md)

使用完整的 `llmhubpp-<版本>-windows-x64.zip`。安装包含离线 Wiki、Inbox 预设和 Windows 终端组件。插件清单最低要求 Obsidian 1.13.0。实机验收使用 Windows 10 x64 与 Obsidian 1.15.0。

## 首次安装

1. 从 [GitHub Releases](https://github.com/Preston-se/llmhubpp/releases) 下载同一内测的 ZIP 和 `SHA256SUMS.txt`，选一个测试库。
2. 用 PowerShell 的 `Get-FileHash -Algorithm SHA256 -LiteralPath <ZIP 路径>` 算出摘要，与 `SHA256SUMS.txt` 核对。
3. 解压并将完整的 `llmhubpp` 文件夹复制到该库配置目录的 `plugins` 下，通常为 `.obsidian/plugins/llmhubpp`。核对其中 `manifest.json` 的 ID 为 `llmhubpp`。
4. 在 **设置 → 第三方插件** 启用 Llmhub++，打开它的 **Wiki 与帮助**。
5. 连接并验证一个本地或 API 文本模型。尝试普通提问，再为合成笔记配置小范围索引，试问一个能点引用回原文的问题。 [首次配置](../resources/help/first-setup.md)

## 升级已有库

备份插件目录和它使用的工作区目录，包含设置、历史、索引、Inbox 脚本和自定义预设。备份放在库外，在隔离库验证还原。设备秘密在更换设备后可能需要重新填写。

先停用插件，将新包程序文件复制进现有插件目录，保留本地配置文件。若来自独立的旧 LLM Hub、Local LLM Hub 或 Safe Guard，先停用这些旧插件并保存它们的目录备份。启用 Llmhub++ 后检查 Wiki、模型、已有索引中的一篇笔记及一个自定义工作流。

## 回退

1. 先保存升级后新增或修改的笔记，再停用 Llmhub++。
2. 恢复同一时点的旧程序、配置和索引备份。如果回退到独立旧插件，恢复后启用对应版本。
3. 检查旧索引和笔记可读，再开启自动索引。旧版可能无法读取新版本生成的索引数据。

[English installation and rollback](INSTALL.md) · [开发与测试](../CONTRIBUTING.md)
