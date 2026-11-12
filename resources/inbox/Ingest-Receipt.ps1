# Private replay receipts. No credentials or document bodies are stored here.
$script:ReceiptPath = $env:LLMHUBPP_INGEST_RECEIPT
$script:Receipt = @{ version=1; original=''; paths=@{}; outputs=@{}; moves=@{}; done=$false }
$script:PathCounters = @{}
function Initialize-IngestReceipt([string]$Original='') {
    if ($script:ReceiptPath -and (Test-Path -LiteralPath $script:ReceiptPath)) {
        $script:Receipt = [IO.File]::ReadAllText($script:ReceiptPath) | ConvertFrom-Json -AsHashtable
        if ($script:Receipt.version -ne 1 -or ($Original -and $script:Receipt.original -ne $Original)) { throw 'Ingest receipt does not match the requested source.' }
    } elseif ($Original) { $script:Receipt.original=$Original }
    foreach($key in @('moveSources','writes')){if(!$script:Receipt.ContainsKey($key)){$script:Receipt[$key]=@{}}}
}
function Save-IngestReceipt {
    if (!$script:ReceiptPath) { return }
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $script:ReceiptPath))
    $temp=$script:ReceiptPath+'.tmp'
    [IO.File]::WriteAllText($temp, ($script:Receipt | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temp,$script:ReceiptPath,$true)
}
function Get-IngestHash([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
    if (!(Test-Path -LiteralPath $Path -PathType Container)) { throw "Missing previously archived resource: $Path" }
    $rows=@(Get-ChildItem -LiteralPath $Path -File -Recurse | Sort-Object FullName | ForEach-Object { ([IO.Path]::GetRelativePath($Path,$_.FullName))+'|'+(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))))
}
function Get-ReceiptSelection([string]$Key,[scriptblock]$Create) {
    $n=if($script:PathCounters.ContainsKey($Key)){$script:PathCounters[$Key]}else{0};$script:PathCounters[$Key]=$n+1
    $fullKey=$Key+'|'+$n
    if($script:Receipt.paths.ContainsKey($fullKey)){return [string]$script:Receipt.paths[$fullKey]}
    $value=& $Create;$script:Receipt.paths[$fullKey]=$value;Save-IngestReceipt;return $value
}
function Get-UniqueFilePath { param([string]$Directory,[string]$FileName) Get-ReceiptSelection "file|$Directory|$FileName" { Get-NewUniqueFilePath -Directory $Directory -FileName $FileName } }
function Get-UniqueDirectoryPath { param([string]$Parent,[string]$Name) Get-ReceiptSelection "directory|$Parent|$Name" { Get-NewUniqueDirectoryPath -Parent $Parent -Name $Name } }
function Get-DocumentDirectory { param([string]$SourceParent,[string]$OutputParent,[string]$Name) Get-ReceiptSelection "document|$SourceParent|$OutputParent|$Name" { Get-NewDocumentDirectory -SourceParent $SourceParent -OutputParent $OutputParent -Name $Name } }
function Assert-IngestDestination([string]$Path) {
    $base=[IO.Path]::GetFullPath($env:VAULT_PATH).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if(![IO.Path]::GetFullPath($Path).StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive destination leaves the vault.'}
}
function Resolve-IngestMovedSource([string]$Original) {
    if(Test-Path -LiteralPath $Original){return $Original}
    if($script:Receipt.moveSources.ContainsKey($Original)){
        $target=[string]$script:Receipt.moveSources[$Original]
        Assert-IngestDestination $target
        if((Get-IngestHash $target) -ne $script:Receipt.moves[$target]){throw "Moved resource changed: $target"}
        return $target
    }
    return $Original
}
function Move-IngestItem { param([string]$LiteralPath,[string]$Destination)
    Assert-IngestDestination $Destination
    if($script:Receipt.moves.ContainsKey($Destination)){
        $expected=[string]$script:Receipt.moves[$Destination]
        if(Test-Path -LiteralPath $Destination){if((Get-IngestHash $Destination) -ne $expected -and (!$script:Receipt.writes.ContainsKey($Destination) -or (Get-IngestHash $Destination) -ne $script:Receipt.writes[$Destination].before)){throw "Archived resource changed; not overwriting: $Destination"};return}
    }else{
        $script:Receipt.moves[$Destination]=Get-IngestHash $LiteralPath
        if(Test-Path -LiteralPath $LiteralPath -PathType Leaf){$script:Receipt.outputs[$Destination]=$script:Receipt.moves[$Destination]}
        if([IO.Path]::GetFullPath($LiteralPath) -eq [IO.Path]::GetFullPath($IncomingAbsolutePath)){$script:Receipt.rawSource=$Destination;$script:Receipt.rawHash=$script:Receipt.moves[$Destination]}
        $script:Receipt.moveSources[$LiteralPath]=$Destination
        Save-IngestReceipt
    }
    if((Get-IngestHash $LiteralPath) -ne $script:Receipt.moves[$Destination]){throw 'Source changed during interrupted archive operation.'}
    Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
function Publish-ReceiptFile([string]$Ready,[string]$Target) {
    $hash=Get-IngestHash $Ready
    if(Test-Path -LiteralPath $Target){
        if(!$script:Receipt.outputs.ContainsKey($Target) -or $script:Receipt.outputs[$Target] -ne $hash -or (Get-IngestHash $Target) -ne $hash){throw "Existing output changed; not overwriting: $Target"}
        Remove-Item -LiteralPath $Ready -Force
        return
    }
    $script:Receipt.outputs[$Target]=$hash;Save-IngestReceipt
    [IO.File]::Move($Ready,$Target)
}
function Write-IngestText([string]$Path,[string]$Text) {
    $before=''
    if(Test-Path -LiteralPath $Path){
        $before=Get-IngestHash $Path
        $pending=$script:Receipt.writes[$Path]
        if(!$script:Receipt.outputs.ContainsKey($Path) -or ($before -ne $script:Receipt.outputs[$Path] -and (!$pending -or $before -ne $pending.before))){throw "Output changed; not overwriting: $Path"}
    }
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text);$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
    $script:Receipt.writes[$Path]=@{before=$before;after=$hash};$script:Receipt.outputs[$Path]=$hash
    if($script:Receipt.rawSource -eq $Path){$script:Receipt.rawPreviousHash=$before;$script:Receipt.rawHash=$hash;$script:Receipt.moves[$Path]=$hash}
    Save-IngestReceipt
    $ready=$Path+'.llmhubpp-tmp';[IO.File]::WriteAllBytes($ready,$bytes);[IO.File]::Move($ready,$Path,$true)
    $script:Receipt.writes.Remove($Path)
    $script:Receipt.rawPreviousHash='';Save-IngestReceipt
}
function Copy-IngestTree { param([string]$LiteralPath,[string]$Destination,[switch]$Recurse,[switch]$Force)
    Assert-IngestDestination $Destination
    foreach($file in (Get-ChildItem -LiteralPath $LiteralPath -File -Recurse)){
        $target=Join-Path $Destination ([IO.Path]::GetRelativePath($LiteralPath,$file.FullName))
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
        $hash=Get-IngestHash $file.FullName
        if(Test-Path -LiteralPath $target){if(!$script:Receipt.outputs.ContainsKey($target) -or $script:Receipt.outputs[$target] -ne $hash -or (Get-IngestHash $target) -ne $hash){throw "Attachment changed; not overwriting: $target"};continue}
        $ready=Join-Path ([IO.Path]::GetTempPath()) ('llmhubpp-copy-'+[Guid]::NewGuid().ToString('N')+'.tmp')
        Copy-Item -LiteralPath $file.FullName -Destination $ready
        if((Get-IngestHash $ready) -ne $hash){throw 'Attachment source changed while copying.'}
        Publish-ReceiptFile -Ready $ready -Target $target
    }
}
function Verify-IngestReceipt {
    foreach($path in $script:Receipt.outputs.Keys){if(!(Test-Path -LiteralPath $path) -or (Get-IngestHash $path) -ne $script:Receipt.outputs[$path]){throw "Saved output changed or missing: $path"}}
}
function Complete-IngestReceipt {
    Initialize-IngestReceipt
    Verify-IngestReceipt
    $script:Receipt.done=$true;Save-IngestReceipt
}

function Remove-IngestPrivateDirectory([string]$Path,[string]$Prefix) {
    if(!$Path -or !(Test-Path -LiteralPath $Path)){return}
    $base=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    $resolved=[IO.Path]::GetFullPath($Path)
    if(!$resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or !(Split-Path -Leaf $resolved).StartsWith($Prefix)){throw 'Unsafe private temporary directory.'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
