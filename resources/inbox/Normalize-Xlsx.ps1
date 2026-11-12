param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
)
$ErrorActionPreference = 'Stop'
# Pandoc 3.13 ignores inlineStr. Normalize a disposable copy only; never
# update the archived workbook. All unrelated ZIP members retain their bytes.
$source = [IO.Path]::GetFullPath($SourcePath)
$destination = [IO.Path]::GetFullPath($DestinationPath)
if ($source.Equals($destination, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to modify source workbook.' }
$inputZip = [IO.Compression.ZipFile]::OpenRead($source)
try {
    $outputStream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
    try {
        $outputZip = [IO.Compression.ZipArchive]::new($outputStream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($entry in $inputZip.Entries) {
                $newEntry = $outputZip.CreateEntry($entry.FullName)
                $read = $entry.Open()
                $write = $newEntry.Open()
                try {
                    if ($entry.FullName -match '^xl/worksheets/[^/]+\.xml$') {
                        $xml = [Xml.XmlDocument]::new()
                        $xml.PreserveWhitespace = $true
                        $xml.XmlResolver = $null
                        $settings = [Xml.XmlReaderSettings]::new()
                        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
                        $reader = [Xml.XmlReader]::Create($read, $settings)
                        try { $xml.Load($reader) } finally { $reader.Dispose() }
                        $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
                        $ns.AddNamespace('s', $xml.DocumentElement.NamespaceURI)
                        foreach ($cell in @($xml.SelectNodes('//s:c[@t="inlineStr"]', $ns))) {
                            $parts = $cell.SelectNodes('s:is/s:t | s:is/s:r/s:t', $ns)
                            $text = ($parts | ForEach-Object { $_.InnerText }) -join ''
                            $inline = $cell.SelectSingleNode('s:is', $ns)
                            if ($inline) { [void]$cell.RemoveChild($inline) }
                            $cell.SetAttribute('t', 'str')
                            $value = $xml.CreateElement('v', $xml.DocumentElement.NamespaceURI)
                            $value.InnerText = $text
                            [void]$cell.AppendChild($value)
                        }
                        $xml.Save($write)
                    } else { $read.CopyTo($write) }
                } finally { $read.Dispose(); $write.Dispose() }
            }
        } finally { $outputZip.Dispose() }
    } finally { $outputStream.Dispose() }
} finally { $inputZip.Dispose() }
