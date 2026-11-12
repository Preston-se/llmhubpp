# Source Auto Ingest

这是可编辑的旧 Inbox 预设，保留 22-SaveFromInternet 目录布局。修改脚本顶部目录、下方 ragSetting 与事件规则即可适配自己的库；不含模型地址或凭据。不覆盖已有工作流，不自动开启文件事件。已有 Office-Lazy-Index 与自定义脚本继续保留。

需要已安装的 PowerShell 7、Pandoc 与 7-Zip。脚本仍保留原件、失败记录、临时文件忽略及根目录过滤；本版补充 XLSX inlineStr 转换副本修复。

独立文件按 `格式/文档名/` 归档；长文在同一目录发布大小受限的正文分段及小目录页，避免巨型Markdown拖慢Obsidian索引。默认每段最多120000字符，可用 `-MaxMarkdownChars` 调整。只有在脚本参数明确加入 `-GroupName` 时，多个输入才合并到指定组；不会自动按编号合并。Markdown及其附件、压缩包内相关资料保持同组。

右下角任务状态可点击查看详情、暂停/继续/取消。暂停在当前小批次或转换阶段结束后生效，取消保留归档原件及之前已落盘索引。任务和已返回的嵌入批次会保存；重启后恢复为暂停，点击继续才重新请求模型。每段完成即保存为可检索索引，缓存进度不等于已经入库。有任务时关闭会提示保存并退出；取消不代表删除文件。自定义脚本中断后需检查原流程，不自动重放。

```hub-workflow
name: Source-Auto-Ingest
options:
  showProgress: true
nodes:
  - id: convert-office
    type: shell
    command: pwsh
    args: '["-NoProfile","-File","LLMHub/tools/llmhubpp-inbox/source-auto-ingest.ps1","-SourceRelativePath","{{_eventFilePath}}"]'
    timeout: "600000"
    throwOnError: "true"
    saveTo: ingestStatus
  - id: sync-rag
    type: rag-sync
    ragSetting: Captured-Sources
```
