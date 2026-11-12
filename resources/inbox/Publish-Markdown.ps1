param(
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$BaseName,
    [Parameter(Mandatory=$true)][string]$Frontmatter,
    [int]$MaxChars = 120000
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Ingest-Receipt.ps1')
Initialize-IngestReceipt
if ($MaxChars -lt 1000) { throw 'MaxChars must be at least 1000.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$stage = Join-Path ([IO.Path]::GetTempPath()) ('llmhubpp-publish-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
function Check-PublishControl {
    $file = $env:LLMHUBPP_TASK_CONTROL
    if (!$file -or !(Test-Path -LiteralPath $file)) { return }
    $announced = $false
    while ($true) {
        try { $control = [IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 50; continue }
        if ($control.cancel) { throw 'Task cancelled.' }
        if (!$control.pause) { return }
        if (!$announced) { Write-Output 'LLMHUBPP_PROGRESS|已暂停|0|0|等待继续'; $announced = $true }
        Start-Sleep -Milliseconds 150
    }
}
function Flush-Part {
    if ($script:buffer.Length -eq 0) { return }
    $path = Join-Path $stage ('{0:D5}.body' -f $script:parts.Count)
    [IO.File]::WriteAllText($path, $script:buffer.ToString(), $utf8)
    [void]$script:parts.Add($path)
    [void]$script:buffer.Clear()
}
$script:buffer = [Text.StringBuilder]::new()
$script:parts = [Collections.Generic.List[string]]::new()
$reader = [IO.StreamReader]::new($InputPath, [Text.Encoding]::UTF8, $true)
$size = (Get-Item -LiteralPath $InputPath).Length
$lines = 0
try {
    while (($line = $reader.ReadLine()) -ne $null) {
        if ($lines % 1000 -eq 0) {
            Check-PublishControl
            Write-Output "LLMHUBPP_PROGRESS|拆分Markdown|$($reader.BaseStream.Position)|$size|$BaseName"
        }
        $lines++
        if ($line -match '^#{1,6}\s' -and $script:buffer.Length -gt $MaxChars * 0.7) { Flush-Part }
        $remaining = $line + "`n"
        # Preserve ordinary Markdown links/images and other short lines as a unit.
        if ($remaining.Length -le $MaxChars -and $script:buffer.Length + $remaining.Length -gt $MaxChars) { Flush-Part }
        while ($remaining.Length -gt 0) {
            $available = $MaxChars - $script:buffer.Length
            if ($available -le 0) { Flush-Part; $available = $MaxChars }
            $take = [Math]::Min($available, $remaining.Length)
            # Do not separate a UTF-16 surrogate pair at the hard limit.
            if ($take -lt $remaining.Length -and [char]::IsHighSurrogate($remaining[$take - 1])) {
                if ($take -eq 1) { Flush-Part; continue }
                $take--
            }
            [void]$script:buffer.Append($remaining.Substring(0, $take))
            $remaining = $remaining.Substring($take)
        }
    }
    Flush-Part
} finally { $reader.Dispose() }
if ($script:parts.Count -eq 0) {
    [IO.File]::WriteAllText((Join-Path $stage '00000.body'), '', $utf8)
    [void]$script:parts.Add((Join-Path $stage '00000.body'))
}
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$links = [Collections.Generic.List[string]]::new()
for ($i=0; $i -lt $script:parts.Count; $i++) {
    Check-PublishControl
    $name = if ($script:parts.Count -eq 1) { "$BaseName.ai.md" } else { '{0}.part-{1:D4}.ai.md' -f $BaseName,($i+1) }
    $target = Join-Path $OutputDirectory $name

    $ready = Join-Path $stage ($name + '.ready')
    [IO.File]::WriteAllText($ready, ($Frontmatter + [IO.File]::ReadAllText($script:parts[$i], [Text.Encoding]::UTF8)), $utf8)
    Publish-ReceiptFile -Ready $ready -Target $target
    [void]$links.Add("- [[$name]]")
    Write-Output "LLMHUBPP_PROGRESS|发布文档分段|$($i+1)|$($script:parts.Count)|$name"
    # Avoid a burst of hundreds of metadata-index operations in Obsidian.
    Start-Sleep -Milliseconds 30
}
if ($script:parts.Count -gt 1) {
    $overview = Join-Path $OutputDirectory "$BaseName.ai.md"

    $text = $Frontmatter + "# $BaseName`n`n正文分为 $($script:parts.Count) 个分段，原件已保留。`n`n" + ($links -join "`n") + "`n"
    $overviewReady=Join-Path $stage 'overview.ready'
    [IO.File]::WriteAllText($overviewReady,$text,$utf8)
    Publish-ReceiptFile -Ready $overviewReady -Target $overview
}
Write-Output "LLMHUBPP_PROGRESS|文档转换完成|$($script:parts.Count)|$($script:parts.Count)|$BaseName"
# Only remove files this invocation created; never recurse over a computed path.
foreach ($part in $script:parts) { Remove-Item -LiteralPath $part -Force }
[IO.Directory]::Delete($stage)
