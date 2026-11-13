# 日常开发

`main` 是公开发布基线。更新本地 `main` 后，用 `fix/<问题>`、`feat/<功能>` 或 `docs/<内容>` 创建工作分支。提交摘要写清行为变化，如 `fix: localize the settings home`。用同一分支的提交和验证证据说明要合入的范围。

| 步骤 | 交付内容 |
| --- | --- |
| 复现 | 记录插件、Obsidian、系统版本和最小步骤，先在隔离库复现 |
| 修改 | 覆盖实际入口。用户可见功能和设置同步中英文、离线 Wiki、功能地图及配置 MCP |
| 验证 | 跑定向测试、lint、完整回归、构建与打包检查。涉及宿主行为用完整 ZIP 在隔离库验证 |
| 评审 | PR 写明触发条件、实际差异和验收结果。CI 通过后合入 `main` |
| 发布 | 从通过 CI 的 `main` 提交创建草稿，核对附件，再公开内测及更新交接。 [发布流程](RELEASING.md) |

展示名使用 **Llmhub++**，仓库、包与插件 ID 使用 **llmhubpp**。旧插件 ID、CSS 类、配置字段、命令 ID、已发布接口和数据路径是兼容契约。调整显示名时维持这些标识和已有用户数据。

新增设置检查简体中文与英文中的名称、说明、按钮、选项、提示和空状态。第三方模型名、用户标签、路径及协议值保留原值。改动帮助或配置字段时按 [开发完成条件](DEVELOPMENT_COMPLETION.md) 同步。

## 架构与 Graphify

宿主入口是 [main-unified.ts](../src/main-unified.ts) 和 [unifiedPlugin.ts](../src/unifiedPlugin.ts)。设置入口是 [SettingsTab](../src/ui/SettingsTab.tsx)，配置事务由 [ConfigurationService](../src/configuration/service.ts) 处理，索引生命周期从 [RagLifecycle](../src/core/ragLifecycle.ts) 追踪。

跨模块关系、入口或主要数据流变化时，用 Graphify 对审阅提交的生产源码和构建入口更新本地图谱。记录 Git SHA、扫描文件摘要、工具版本与未抽取项。核对关键关系的源码位置和新增循环。纯文案提交可沿用同结构图谱并记录对应版本。扫描范围排除依赖、构建、日志、库数据和凭据。
