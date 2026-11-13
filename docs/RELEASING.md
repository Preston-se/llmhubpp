# 发布 Windows 内测

每次发布以通过验证的 `main` 提交为起点。保留已发布的 ZIP 和对应标签，以便按版本回退。

1. 选一个未使用的三段版本号。用 `npm version <版本> --no-git-tag-version --ignore-scripts` 更新包与锁文件，再运行 `node version-bump.mjs` 对齐 `manifest.json`、`versions.json`，并写 CHANGELOG。
2. 在独立开发分支验证 lint、全量测试、构建、打包和原生宿主。评审后合入 `main`，确认该提交的 **Build and test** 成功。
3. 在 GitHub Actions 的 **Draft Windows beta release** 上选择 `main` 并输入相同版本。推送版本提交即可，发布工作流会绑定该提交。
4. 下载草稿里的完整 ZIP 与 `SHA256SUMS.txt`，核对版本、文件清单、提交和 SHA-256。用相同 ZIP 验收安装、配置、索引与回退。整理实际通过的宿主和系统范围。
5. 将草稿公开为 prerelease。用匿名链接重新下载并核对摘要，记录 Release、标签 SHA、工作流、测试报告及回退版本。

## 构建失败或重试

在 Actions 打开邮件指向的运行，先看最先失败的步骤及它构建的 Git SHA。首发曾因 Windows 检出把生成设置目录的 LF 转成 CRLF，在校验步骤失败。新提交通过后，新运行会有独立记录。已公开附件以发布标签及其 SHA-256 为准。

修复提交后先确认新 `main` 的 CI。如果版本还没有草稿或标签，可以从修复后的 `main` 再触发草稿。若草稿已存在，先核对目标提交及附件，按发布记录处理。已公开版本的后续修复使用新版本。

[安装与回退](INSTALL.zh-CN.md) · [开发与测试](../CONTRIBUTING.md)
