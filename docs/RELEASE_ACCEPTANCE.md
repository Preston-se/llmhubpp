# 晋级验收记录

稳定版只从**已经公开、已经验收过**的内测包晋级，不重新打包。晋级判断依据是仓库里的这份验收记录加上已发布附件本身，所以记录必须与那次内测的实际文件一致。

文件位置：`docs/releases/<版本>.json`，例如 `docs/releases/1.261113.1.json`。`example.json` 只是字段示例，永远不能用于晋级。

## 字段

| 字段 | 含义 | 怎么得到 |
| --- | --- | --- |
| `schemaVersion` | 记录格式版本，当前为 `1` | 固定写 `1` |
| `version` | 内测版本号，三段数字 | 与 `manifest.json` 一致 |
| `commit` | 该版本对应的完整 40 位提交 | 发布标签指向的提交，`git rev-parse <版本>` |
| `zipSha256` | 内测 ZIP 的 SHA-256 | `Get-FileHash -Algorithm SHA256 <ZIP>` |
| `anonymousDownloadSha256` | 用匿名链接重新下载同一 ZIP 后的 SHA-256 | 未登录状态下载后再算一次，必须与上一行相同 |
| `reviewer` | 完成验收的人或角色 | 写名字或角色，不要留空 |
| `testedAt` | 验收日期 | `YYYY-MM-DD` |
| `evidence` | 验收证据的位置 | Issue、PR 或项目内验收记录路径 |
| `isolatedVault` | 是否在一次性测试库里验收 | 必须是 `true`；在个人库里试不算 |
| `rollbackVersion` | 回退目标版本 | 一个更早的已发布版本，不能等于本版本 |
| `blockers` | 未解决的阻塞项 | 没有就写 `[]`；有内容时晋级会被拒绝 |
| `environments` | 实际测过的环境列表 | 每项含 `os`、`arch`、`obsidian`、`checks` |

`environments[].checks` 九项全部为 `pass` 才算通过：`install`、`taskCenter`、`indexing`、`searchAuthorization`、`configuration`、`localModels`、`customizations`、`upgrade`、`rollback`。写 `pending` 或 `fail` 都会被拒绝。

## 每一项怎么测

用完整 ZIP 在一次性库中安装，按顺序做：

- `install`：首次安装后插件能启用，离线 Wiki 能打开。
- `taskCenter`：改动一篇笔记后，任务中心出现待索引任务并能完成。
- `indexing`：索引一篇笔记后，问答能命中并给出可点回原文的引用。
- `searchAuthorization`：知识库搜索授权后重载插件，授权状态保留。
- `configuration`：打开设置各分组，改动一项配置并重载后仍生效。
- `localModels`：本地模型能连接并完成一次普通提问。
- `customizations`：自定义预设或脚本仍在，且能运行。
- `upgrade`：从上一版本升级后，原有配置、索引、聊天记录保留。
- `rollback`：回退到 `rollbackVersion` 后，笔记与旧索引仍可读。

只测了 Windows 10 就只写 Windows 10。没测的环境不要写进去，也不要在发行说明里声称支持。

## 晋级时会发生什么

`promote.yml` 会按顺序检查，任一不通过就停止，且不会改动 Release：

1. 记录里指名的版本、提交、ZIP 摘要与实际下载的附件一致。
2. 发布标签指向的提交与记录一致，报告里的构建来源也一致。
3. 该构建运行成功，附件里没有多余或缺失文件。
4. 验收覆盖的环境全部 `pass`，没有阻塞项，匿名下载摘要一致。
5. 只有显式选择 `publish=true` 时，才把同一个 Release 的预发行标记去掉；不上传、不替换、不重新打包。

## 回退

晋级只是去掉预发行标记，附件没变。要撤销，把该 Release 重新标为预发行，或让用户继续使用上一个版本；已下载的旧包始终可用。
