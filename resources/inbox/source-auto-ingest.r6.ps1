param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRelativePath,
    [string]$GroupName = "",
    [int]$MaxMarkdownChars = 120000
)

$ErrorActionPreference = "Stop"

function Write-IngestProgress([string]$Stage, [string]$Detail = "") {
    Write-Output "LLMHUBPP_PROGRESS|$Stage|0|0|$Detail"
}
function Check-IngestControl {
    $controlPath = $env:LLMHUBPP_TASK_CONTROL
    if (!$controlPath -or !(Test-Path -LiteralPath $controlPath)) { return }
    $announced = $false
    while ($true) {
        try { $state = [IO.File]::ReadAllText($controlPath) | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 50; continue }
        if ($state.cancel) { throw 'Task cancelled.' }
        if (!$state.pause) { return }
        if (!$announced) { Write-IngestProgress '已暂停' '等待继续'; $announced = $true }
        Start-Sleep -Milliseconds 150
    }
}
if ($GroupName -and ($GroupName -in @('.', '..') -or $GroupName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0)) { throw 'Invalid document group name.' }

# ============================================================
# 0. UTF-8
# ============================================================

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSStyle.OutputRendering = "PlainText"
}

$env:NO_COLOR = "1"

# ============================================================
# 1. 基础路径
# ============================================================

$VaultRoot = $env:VAULT_PATH

if ([string]::IsNullOrWhiteSpace($VaultRoot)) {
    throw "VAULT_PATH is empty."
}

$VaultRoot = [System.IO.Path]::GetFullPath($VaultRoot)

$BaseRelative = "22-SaveFromInternet"
$InboxRelative = "$BaseRelative/00-Inbox"
$SourceRootRelative = "$BaseRelative/10-Source"
$ExtractedRootRelative = "$BaseRelative/20-Extracted"
$FailedRootRelative = "$BaseRelative/90-Failed"

$InboxAbsolute = Join-Path $VaultRoot ($InboxRelative.Replace("/", "\"))
$SourceRootAbsolute = Join-Path $VaultRoot ($SourceRootRelative.Replace("/", "\"))
$ExtractedRootAbsolute = Join-Path $VaultRoot ($ExtractedRootRelative.Replace("/", "\"))
$FailedRootAbsolute = Join-Path $VaultRoot ($FailedRootRelative.Replace("/", "\"))

$SourceRelativePath = $SourceRelativePath.Replace("\", "/").TrimStart("/")
$relativePrefix = "$InboxRelative/"

if (-not $SourceRelativePath.StartsWith(
    $relativePrefix,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    Write-Output "SKIPPED|outside-inbox|$SourceRelativePath"
    exit 0
}

$insideInbox = $SourceRelativePath.Substring($relativePrefix.Length)

# V2.2 的触发器只应匹配 Inbox 根目录文件。
# 即使错误地触发到子目录，这里也会再次拦截。
if ($insideInbox.Contains("/")) {
    Write-Output "SKIPPED|nested-inbox-item|$SourceRelativePath"
    exit 0
}

$IncomingAbsolutePath = Join-Path $VaultRoot ($SourceRelativePath.Replace("/", "\"))

# ============================================================
# 2. 临时下载文件忽略
# ============================================================

$fileNameForCheck = [System.IO.Path]::GetFileName($IncomingAbsolutePath)

$tempSuffixes = @(
    ".crdownload",
    ".part",
    ".partial",
    ".download",
    ".tmp",
    ".temp"
)

foreach ($suffix in $tempSuffixes) {
    if ($fileNameForCheck.EndsWith(
        $suffix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        Write-Output "IGNORED_TEMP|$SourceRelativePath"
        exit 0
    }
}

# ============================================================
# 3. 通用工具
# ============================================================

function Ensure-Directory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-UniqueFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [Parameter(Mandatory = $true)]
        [string]$FileName
    )

    $candidate = Join-Path $Directory $FileName

    if (-not (Test-Path -LiteralPath $candidate)) {
        return $candidate
    }

    $stem = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    $extension = [System.IO.Path]::GetExtension($FileName)
    $i = 2

    while ($true) {
        $candidate = Join-Path $Directory "$stem ($i)$extension"
        if (-not (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
        $i++
    }
}

function Get-UniqueDirectoryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Parent,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $candidate = Join-Path $Parent $Name

    if (-not (Test-Path -LiteralPath $candidate)) {
        return $candidate
    }

    $i = 2
    while ($true) {
        $candidate = Join-Path $Parent "$Name ($i)"
        if (-not (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
        $i++
    }
}

function Get-DocumentDirectory {
    param([string]$SourceParent, [string]$OutputParent, [string]$Name)
    if ($GroupName) { return (Join-Path $SourceParent $Name) }
    $serial = 1
    while ($true) {
        $candidate = if ($serial -eq 1) { $Name } else { "$Name ($serial)" }
        if (!(Test-Path -LiteralPath (Join-Path $SourceParent $candidate)) -and !(Test-Path -LiteralPath (Join-Path $OutputParent $candidate))) { return (Join-Path $SourceParent $candidate) }
        $serial++
    }
}

function Wait-FileStable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [int]$TimeoutSeconds = 300
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stableRounds = 0

    while ((Get-Date) -lt $deadline) {
        Check-IngestControl
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            Start-Sleep -Milliseconds 500
            continue
        }

        try {
            $before = Get-Item -LiteralPath $Path
            $beforeLength = $before.Length
            $beforeWrite = $before.LastWriteTimeUtc

            Start-Sleep -Milliseconds 1000

            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                $stableRounds = 0
                continue
            }

            $after = Get-Item -LiteralPath $Path
            $same = (
                $beforeLength -eq $after.Length -and
                $beforeWrite -eq $after.LastWriteTimeUtc
            )

            $exclusiveAvailable = $false
            if ($same) {
                try {
                    $stream = [System.IO.File]::Open(
                        $Path,
                        [System.IO.FileMode]::Open,
                        [System.IO.FileAccess]::Read,
                        [System.IO.FileShare]::None
                    )
                    $stream.Dispose()
                    $exclusiveAvailable = $true
                }
                catch {
                    $exclusiveAvailable = $false
                }
            }

            if ($same -and $exclusiveAvailable) {
                $stableRounds++
            }
            else {
                $stableRounds = 0
            }

            if ($stableRounds -ge 2) {
                return
            }
        }
        catch {
            $stableRounds = 0
        }

        Start-Sleep -Milliseconds 500
    }

    throw "File did not become stable within $TimeoutSeconds seconds: $Path"
}

function Wait-DirectoryStable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [int]$AppearTimeoutSeconds = 30,
        [int]$StableTimeoutSeconds = 300
    )

    $appearDeadline = (Get-Date).AddSeconds($AppearTimeoutSeconds)

    while (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Check-IngestControl
        if ((Get-Date) -gt $appearDeadline) {
            return $false
        }
        Start-Sleep -Milliseconds 500
    }

    $deadline = (Get-Date).AddSeconds($StableTimeoutSeconds)
    $stableRounds = 0

    while ((Get-Date) -lt $deadline) {
        Check-IngestControl
        try {
            $beforeFiles = @(Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction Stop)
            $beforeCount = $beforeFiles.Count
            $beforeSize = ($beforeFiles | Measure-Object Length -Sum).Sum
            if ($null -eq $beforeSize) { $beforeSize = 0 }

            Start-Sleep -Milliseconds 1000

            $afterFiles = @(Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction Stop)
            $afterCount = $afterFiles.Count
            $afterSize = ($afterFiles | Measure-Object Length -Sum).Sum
            if ($null -eq $afterSize) { $afterSize = 0 }

            if ($beforeCount -eq $afterCount -and $beforeSize -eq $afterSize) {
                $stableRounds++
            }
            else {
                $stableRounds = 0
            }

            # 3 个稳定周期，降低“附件文件夹刚出现但还没复制完”的竞态。
            if ($stableRounds -ge 3) {
                return $true
            }
        }
        catch {
            $stableRounds = 0
        }

        Start-Sleep -Milliseconds 500
    }

    return $false
}

function Get-Category {
    param([string]$Extension)

    switch ($Extension.ToLowerInvariant()) {
        ".docx" { return "Word" }
        ".pptx" { return "PowerPoint" }
        ".xlsx" { return "Excel" }
        ".pdf" { return "PDF" }
        ".md" { return "Markdown" }
        ".markdown" { return "Markdown" }
        ".png" { return "Image" }
        ".jpg" { return "Image" }
        ".jpeg" { return "Image" }
        ".webp" { return "Image" }
        ".gif" { return "Image" }
        ".bmp" { return "Image" }
        ".tif" { return "Image" }
        ".tiff" { return "Image" }
        ".heic" { return "Image" }
        ".html" { return "Web" }
        ".htm" { return "Web" }
        ".txt" { return "Text" }
        ".epub" { return "EPUB" }
        ".zip" { return "Archive" }
        ".7z" { return "Archive" }
        default {
            if ([string]::IsNullOrWhiteSpace($Extension)) {
                return "NO_EXTENSION"
            }
            return $Extension.TrimStart(".").ToUpperInvariant()
        }
    }
}

function Write-FailureRecord {
    param(
        [string]$SourcePath,
        [string]$Category,
        [string]$Message
    )

    try {
        $failureDir = Join-Path $FailedRootAbsolute $Category
        Ensure-Directory $failureDir

        $sourceBaseName = [System.IO.Path]::GetFileName($SourcePath)
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $failureFile = Join-Path $failureDir "$sourceBaseName.$stamp.error.txt"

        $text = @"
Time:
$(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Source:
$SourcePath

Error:
$Message
"@

        [System.IO.File]::WriteAllText($failureFile, $text, $Utf8NoBom)
    }
    catch {
        # 不允许日志写入失败覆盖真正异常。
    }
}

function Find-SevenZip {
    $commands = @("7z.exe", "7zz.exe")

    foreach ($command in $commands) {
        $cmd = Get-Command $command -ErrorAction SilentlyContinue
        if ($cmd) {
            return $cmd.Source
        }
    }

    $candidates = @(
        "D:\20499\Apps\解压缩软件\7-Zip\7z.exe",
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

# ============================================================
# 4. Markdown 附件识别与路径重写
# ============================================================

function Get-MarkdownAttachmentFolders {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $targets = New-Object System.Collections.Generic.List[string]

    # 标准 Markdown：![](assets/a.png) / [](files/a.pdf)
    $inlinePattern = '!?' + '\[[^]]*\]' + '\((?<target>[^)\r\n]+)\)'

    foreach ($match in [regex]::Matches(
        $Content,
        $inlinePattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )) {
        $targets.Add($match.Groups["target"].Value)
    }

    # Obsidian Wiki：![[assets/a.png]] / [[files/a.pdf]]
    $wikiPattern = '!?' + '\[\[(?<target>[^]]+)\]\]'

    foreach ($match in [regex]::Matches(
        $Content,
        $wikiPattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )) {
        $targets.Add($match.Groups["target"].Value)
    }

    # HTML：<img src="assets/a.png"> / <a href="files/a.pdf">
    $htmlPattern = '(?:src|href)\s*=\s*["''](?<target>[^"'']+)["'']'

    foreach ($match in [regex]::Matches(
        $Content,
        $htmlPattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )) {
        $targets.Add($match.Groups["target"].Value)
    }

    $folders = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($rawTarget in $targets) {
        if ([string]::IsNullOrWhiteSpace($rawTarget)) {
            continue
        }

        $target = $rawTarget.Trim()

        # Markdown 可选 title：assets/a.png "caption"
        if ($target -match '^(?<path>\S+)\s+["''][^"'']*["'']$') {
            $target = $Matches["path"]
        }

        $target = $target.Trim("<", ">")

        if ($target.Contains("|")) {
            $target = $target.Split("|")[0]
        }

        if ($target.Contains("#")) {
            $target = $target.Split("#")[0]
        }

        # 去掉常见 query，避免 image.png?raw=1 影响判断。
        if ($target.Contains("?")) {
            $target = $target.Split("?")[0]
        }

        if (
            [string]::IsNullOrWhiteSpace($target) -or
            $target.StartsWith("#") -or
            $target.StartsWith("/") -or
            $target.StartsWith("\") -or
            $target -match '^[A-Za-z][A-Za-z0-9+.-]*:'
        ) {
            continue
        }

        $target = $target.Replace("\", "/")

        while ($target.StartsWith("./")) {
            $target = $target.Substring(2)
        }

        try {
            $decoded = [System.Uri]::UnescapeDataString($target)
        }
        catch {
            $decoded = $target
        }

        $parts = $decoded.Split("/", [System.StringSplitOptions]::RemoveEmptyEntries)

        # V2.2 只接管“与 MD 同级的附件文件夹”。
        if ($parts.Count -lt 2) {
            continue
        }

        $topFolder = $parts[0]

        if (
            [string]::IsNullOrWhiteSpace($topFolder) -or
            $topFolder -eq "." -or
            $topFolder -eq ".."
        ) {
            continue
        }

        [void]$folders.Add($topFolder)
    }

    return @($folders)
}

function Rewrite-MarkdownAttachmentLinks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Content,

        [Parameter(Mandatory = $true)]
        [hashtable]$FolderMap
    )

    $result = $Content

    foreach ($oldFolder in $FolderMap.Keys) {
        $newPrefix = $FolderMap[$oldFolder]
        $encodedPrefix = $newPrefix.Replace(" ", "%20")
        $escapedOld = [regex]::Escape($oldFolder)

        # Markdown inline links
        $pattern1 = "(?<prefix>\]\()\./$escapedOld/"
        $replace1 = '${prefix}' + $encodedPrefix + "/"
        $result = [regex]::Replace($result, $pattern1, $replace1, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

        $pattern2 = "(?<prefix>\]\()$escapedOld/"
        $replace2 = '${prefix}' + $encodedPrefix + "/"
        $result = [regex]::Replace($result, $pattern2, $replace2, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

        # Obsidian Wiki links
        $pattern3 = "(?<prefix>\[\[)\./$escapedOld/"
        $replace3 = '${prefix}' + $newPrefix + "/"
        $result = [regex]::Replace($result, $pattern3, $replace3, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

        $pattern4 = "(?<prefix>\[\[)$escapedOld/"
        $replace4 = '${prefix}' + $newPrefix + "/"
        $result = [regex]::Replace($result, $pattern4, $replace4, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

        # HTML src / href
        $pattern5 = '(?<prefix>(?:src|href)\s*=\s*["''])\./{0}/' -f $escapedOld
        $replace5 = '${prefix}' + $encodedPrefix + "/"
        $result = [regex]::Replace($result, $pattern5, $replace5, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

        $pattern6 = '(?<prefix>(?:src|href)\s*=\s*["'']){0}/' -f $escapedOld
        $replace6 = '${prefix}' + $encodedPrefix + "/"
        $result = [regex]::Replace($result, $pattern6, $replace6, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }

    return $result
}

# ============================================================
# 5. 等待主文件稳定
# ============================================================

$existsDeadline = (Get-Date).AddSeconds(20)

while (-not (Test-Path -LiteralPath $IncomingAbsolutePath -PathType Leaf)) {
    if ((Get-Date) -gt $existsDeadline) {
        throw "Incoming file did not appear: $IncomingAbsolutePath"
    }
    Start-Sleep -Milliseconds 300
}

Write-IngestProgress '等待文件稳定' $SourceRelativePath
Check-IngestControl
Wait-FileStable -Path $IncomingAbsolutePath -TimeoutSeconds 300

$incomingItem = Get-Item -LiteralPath $IncomingAbsolutePath
$extension = [System.IO.Path]::GetExtension($incomingItem.Name).ToLowerInvariant()
$category = Get-Category $extension
$documentName = if ($GroupName) { $GroupName } else { [IO.Path]::GetFileNameWithoutExtension($incomingItem.Name) }
Write-IngestProgress '归档原件' $incomingItem.Name
Check-IngestControl

# ============================================================
# 6. ZIP / 7Z：Markdown Bundle 批量导入
# ============================================================

if ($extension -eq ".zip" -or $extension -eq ".7z") {
    $archiveType = if ($extension -eq ".zip") { "ZIP" } else { "7Z" }
    $archiveRoot = Join-Path (Join-Path $SourceRootAbsolute "Archive") $archiveType
    Ensure-Directory $archiveRoot
    $archiveSourceDir = Get-DocumentDirectory -SourceParent $archiveRoot -OutputParent (Join-Path $SourceRootAbsolute "Markdown") -Name $documentName
    Ensure-Directory $archiveSourceDir

    $sevenZip = Find-SevenZip
    if ([string]::IsNullOrWhiteSpace($sevenZip)) {
        Write-FailureRecord -SourcePath $IncomingAbsolutePath -Category "Archive" -Message "7-Zip CLI not found."
        throw "7-Zip CLI not found."
    }

    $tempExtractRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("obsidian-archive-" + [System.Guid]::NewGuid().ToString("N"))
    Ensure-Directory $tempExtractRoot

    $markdownRoot = Join-Path $SourceRootAbsolute "Markdown"
    Ensure-Directory $markdownRoot
    $markdownSourceDir = Join-Path $markdownRoot (Split-Path -Leaf $archiveSourceDir)
    Ensure-Directory $markdownSourceDir

    $importedMarkdown = 0
    $importedAttachmentFolders = 0

    try {
        # 解压始终发生在 Vault 外，避免大量 Obsidian create 事件。
        & $sevenZip "x" "-y" "-o$tempExtractRoot" $IncomingAbsolutePath | Out-Null

        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip extraction failed with exit code $LASTEXITCODE"
        }

        $markdownFiles = @(
            Get-ChildItem -LiteralPath $tempExtractRoot -File -Recurse |
                Where-Object { $_.Extension.ToLowerInvariant() -in @(".md", ".markdown") }
        )

        foreach ($markdownFile in $markdownFiles) {
            $content = Get-Content -LiteralPath $markdownFile.FullName -Raw -Encoding UTF8
            $attachmentFolders = @(Get-MarkdownAttachmentFolders -Content $content)

            # RAG 当前按 .md 使用，因此归档导入统一规范为 .md。
            $desiredName = ([System.IO.Path]::GetFileNameWithoutExtension($markdownFile.Name)) + ".md"
            $destinationMarkdown = Get-UniqueFilePath -Directory $markdownSourceDir -FileName $desiredName
            $destinationBaseName = [System.IO.Path]::GetFileNameWithoutExtension($destinationMarkdown)

            $folderMap = @{}

            foreach ($folderName in $attachmentFolders) {
                $sourceAttachmentFolder = Join-Path $markdownFile.DirectoryName $folderName

                if (-not (Test-Path -LiteralPath $sourceAttachmentFolder -PathType Container)) {
                    # 压缩包里缺附件时不阻塞正文导入，但历史输出会给出提示。
                    Write-Output "ARCHIVE_ATTACHMENT_MISSING|$($markdownFile.FullName)|$folderName"
                    continue
                }

                $documentAttachmentRoot = Join-Path (Join-Path $markdownSourceDir "附件") $destinationBaseName
                Ensure-Directory $documentAttachmentRoot

                $destinationAttachmentFolder = Get-UniqueDirectoryPath -Parent $documentAttachmentRoot -Name $folderName
                Copy-Item -LiteralPath $sourceAttachmentFolder -Destination $destinationAttachmentFolder -Recurse -Force

                $destinationFolderName = Split-Path -Leaf $destinationAttachmentFolder
                $folderMap[$folderName] = "附件/$destinationBaseName/$destinationFolderName"
                $importedAttachmentFolders++
            }

            if ($folderMap.Count -gt 0) {
                $content = Rewrite-MarkdownAttachmentLinks -Content $content -FolderMap $folderMap
            }

            [System.IO.File]::WriteAllText($destinationMarkdown, $content, $Utf8NoBom)
            $importedMarkdown++
        }

        # 所有 Markdown 处理成功后，才把原始压缩包从 Inbox 移入永久原件层。
        $finalArchivePath = Get-UniqueFilePath -Directory $archiveSourceDir -FileName $incomingItem.Name
        Move-Item -LiteralPath $IncomingAbsolutePath -Destination $finalArchivePath

        $finalArchiveRelative = [System.IO.Path]::GetRelativePath($VaultRoot, $finalArchivePath).Replace("\", "/")

        Start-Sleep -Milliseconds 1200

        if ($importedMarkdown -eq 0) {
            Write-Output "ARCHIVE_STORED_NO_MARKDOWN|$finalArchiveRelative"
        }
        else {
            Write-Output "ARCHIVE_IMPORTED|$finalArchiveRelative|MARKDOWN=$importedMarkdown|ATTACHMENT_FOLDERS=$importedAttachmentFolders"
        }

        exit 0
    }
    catch {
        Write-FailureRecord -SourcePath $IncomingAbsolutePath -Category "Archive" -Message $_.Exception.Message
        throw
    }
    finally {
        if (Test-Path -LiteralPath $tempExtractRoot -PathType Container) {
            Remove-Item -LiteralPath $tempExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ============================================================
# 7. 普通文件分类目录
# ============================================================

$categoryRoot = Join-Path $SourceRootAbsolute $category
Ensure-Directory $categoryRoot
$sourceCategoryDir = Get-DocumentDirectory -SourceParent $categoryRoot -OutputParent (Join-Path $ExtractedRootAbsolute $category) -Name $documentName
Ensure-Directory $sourceCategoryDir

# ============================================================
# 8. Markdown + 同级附件文件夹
# ============================================================

if ($category -eq "Markdown") {
    $markdownOriginalContent = Get-Content -LiteralPath $IncomingAbsolutePath -Raw -Encoding UTF8
    $markdownAttachmentFolders = @(Get-MarkdownAttachmentFolders -Content $markdownOriginalContent)

    # 在移动主 MD 前，先确认它引用的同级附件目录已经完全出现且稳定。
    foreach ($folderName in $markdownAttachmentFolders) {
        $sourceAttachmentFolder = Join-Path $InboxAbsolute $folderName
        $stable = Wait-DirectoryStable -Path $sourceAttachmentFolder -AppearTimeoutSeconds 30 -StableTimeoutSeconds 300

        if (-not $stable) {
            Write-FailureRecord -SourcePath $IncomingAbsolutePath -Category "Markdown" -Message "Attachment folder missing or unstable: $folderName"
            throw "Attachment folder missing or unstable: $folderName"
        }
    }

    $desiredName = if ($extension -eq ".markdown") {
        ([System.IO.Path]::GetFileNameWithoutExtension($incomingItem.Name)) + ".md"
    }
    else {
        $incomingItem.Name
    }

    $finalSourcePath = Get-UniqueFilePath -Directory $sourceCategoryDir -FileName $desiredName
    $actualBaseName = [System.IO.Path]::GetFileNameWithoutExtension($finalSourcePath)
    $folderMap = @{}
    $movedAttachmentCount = 0

    # 先移动主 MD。
    Move-Item -LiteralPath $IncomingAbsolutePath -Destination $finalSourcePath

    foreach ($folderName in $markdownAttachmentFolders) {
        $sourceAttachmentFolder = Join-Path $InboxAbsolute $folderName
        $documentAttachmentRoot = $sourceCategoryDir
        Ensure-Directory $documentAttachmentRoot

        $destinationAttachmentFolder = Get-UniqueDirectoryPath -Parent $documentAttachmentRoot -Name $folderName
        Move-Item -LiteralPath $sourceAttachmentFolder -Destination $destinationAttachmentFolder

        $destinationFolderName = Split-Path -Leaf $destinationAttachmentFolder
        $folderMap[$folderName] = $destinationFolderName
        $movedAttachmentCount++
    }

    if ($folderMap.Count -gt 0) {
        $rewrittenContent = Rewrite-MarkdownAttachmentLinks -Content $markdownOriginalContent -FolderMap $folderMap
        [System.IO.File]::WriteAllText($finalSourcePath, $rewrittenContent, $Utf8NoBom)
    }

    $finalSourceRelative = [System.IO.Path]::GetRelativePath($VaultRoot, $finalSourcePath).Replace("\", "/")
    Start-Sleep -Milliseconds 1200

    Write-Output "DIRECT_MARKDOWN|$finalSourceRelative|ATTACHMENT_FOLDERS=$movedAttachmentCount"
    exit 0
}

# ============================================================
# 9. 其他原件先进入 10-Source
# ============================================================

$finalSourcePath = Get-UniqueFilePath -Directory $sourceCategoryDir -FileName $incomingItem.Name
Move-Item -LiteralPath $IncomingAbsolutePath -Destination $finalSourcePath

$finalSourceItem = Get-Item -LiteralPath $finalSourcePath
$finalSourceRelative = [System.IO.Path]::GetRelativePath($VaultRoot, $finalSourcePath).Replace("\", "/")

# PDF 继续交给 LLM Hub 原生提取。
if ($category -eq "PDF") {
    Start-Sleep -Milliseconds 800
    Write-Output "DIRECT_PDF|$finalSourceRelative"
    exit 0
}

# 图片当前只保存原件，下一阶段接 Qwen3-VL。
if ($category -eq "Image") {
    Write-Output "VISUAL_PENDING|$finalSourceRelative"
    exit 0
}

# ============================================================
# 10. Office / HTML / EPUB / TXT -> 20-Extracted
# ============================================================

$pandocFormat = $null

switch ($extension) {
    ".docx" { $pandocFormat = "docx" }
    ".pptx" { $pandocFormat = "pptx" }
    ".xlsx" { $pandocFormat = "xlsx" }
    ".html" { $pandocFormat = "html" }
    ".htm" { $pandocFormat = "html" }
    ".epub" { $pandocFormat = "epub" }
}

$plainTextConversion = ($extension -eq ".txt")

if ([string]::IsNullOrWhiteSpace($pandocFormat) -and -not $plainTextConversion) {
    Write-Output "STORED_NO_RAG|$finalSourceRelative"
    exit 0
}

$extractedCategoryDir = Join-Path (Join-Path $ExtractedRootAbsolute $category) (Split-Path -Leaf $sourceCategoryDir)
Ensure-Directory $extractedCategoryDir

$actualBaseName = [System.IO.Path]::GetFileNameWithoutExtension($finalSourceItem.Name)
$sidecarPath = Join-Path $extractedCategoryDir "$actualBaseName.ai.md"
$assetsName = "$actualBaseName.assets"

$tempFileName = "obsidian-ingest-" + [System.Guid]::NewGuid().ToString("N") + ".md"
$tempPath = Join-Path ([System.IO.Path]::GetTempPath()) $tempFileName
$normalizedWorkbook = $null

try {
    Write-IngestProgress '正在转换Markdown' $finalSourceItem.Name
    Check-IngestControl
    if ($plainTextConversion) {
        Copy-Item -LiteralPath $finalSourcePath -Destination $tempPath
    }
    else {
        $pandocSource = $finalSourcePath
        if ($extension -eq '.xlsx') {
            $normalizedWorkbook = Join-Path ([IO.Path]::GetTempPath()) ('llmhubpp-' + [Guid]::NewGuid().ToString('N') + '.xlsx')
            & (Join-Path $PSScriptRoot 'Normalize-Xlsx.ps1') -SourcePath $finalSourcePath -DestinationPath $normalizedWorkbook
            $pandocSource = $normalizedWorkbook
        }
        Push-Location $extractedCategoryDir
        try {
            $pandocArgs = @(
                $pandocSource,
                "-f", $pandocFormat,
                "-t", "gfm",
                "--wrap=none"
            )

            if ($extension -in @(".docx", ".pptx", ".xlsx", ".epub")) {
                $pandocArgs += "--extract-media=$assetsName"
            }

            $pandocArgs += @("-o", $tempPath)

            & pandoc @pandocArgs

            if ($LASTEXITCODE -ne 0) {
                throw "Pandoc failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }

        if (-not (Test-Path -LiteralPath $tempPath -PathType Leaf)) {
            throw "Pandoc did not create output Markdown."
        }

    }

    $generatedAt = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    $yamlSourcePath = $finalSourceRelative.Replace("'", "''")

    $frontmatter = @"
---
ai_sidecar: true
source: '[[$yamlSourcePath]]'
source_path: '$yamlSourcePath'
source_type: '$($extension.TrimStart("."))'
source_category: '$category'
generated_by: 'Source-Auto-Ingest-Managed'
generated_at: '$generatedAt'
---

"@

    Check-IngestControl
    & (Join-Path $PSScriptRoot 'Publish-Markdown.ps1') -InputPath $tempPath -OutputDirectory $extractedCategoryDir -BaseName $actualBaseName -Frontmatter $frontmatter -MaxChars $MaxMarkdownChars
}
catch {
    Write-FailureRecord -SourcePath $finalSourcePath -Category $category -Message $_.Exception.Message
    throw
}
finally {
    if ($normalizedWorkbook -and (Test-Path -LiteralPath $normalizedWorkbook)) {
        Remove-Item -LiteralPath $normalizedWorkbook -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Milliseconds 1200

$sidecarRelative = [System.IO.Path]::GetRelativePath($VaultRoot, $sidecarPath).Replace("\", "/")
Write-Output "CONVERTED|$finalSourceRelative|$sidecarRelative"
