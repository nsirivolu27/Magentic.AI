param([string]$Destination, [switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
if (-not $Destination) { $Destination = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MagenticDeveloper\application' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'The destination already exists. Choose a new directory; existing installations are never overwritten.' }
$sourcePath = [IO.Path]::GetFullPath($PSScriptRoot)
if ($destinationPath.StartsWith($sourcePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install outside the extracted package directory.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'checksums.json') -Raw | ConvertFrom-Json
foreach ($file in $manifest.PSObject.Properties) {
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $file.Name))
    if (-not $source.StartsWith($sourcePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The package contains an invalid path.' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $file.Value) { throw "Package verification failed: $($file.Name)" }
}
# Only listed application files are copied. Browser data and logs stay outside
# the installation so replacing the application cannot erase them.
New-Item -ItemType Directory -Path $destinationPath | Out-Null
foreach ($file in $manifest.PSObject.Properties) {
    $target = Join-Path $destinationPath $file.Name
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file.Name) -Destination $target
}
if (-not $NoShortcuts) {
    $shell = New-Object -ComObject WScript.Shell
    $programs = [Environment]::GetFolderPath('Programs')
    $shortcut = $shell.CreateShortcut((Join-Path $programs 'Magentic Developer.lnk'))
    $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
    $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $destinationPath 'Start-Magentic.ps1') + '"'
    $shortcut.WorkingDirectory = $destinationPath
    $shortcut.Description = 'Magentic Developer — local development workflows and MCP'
    $shortcut.Save()
}
Write-Output "Installed Magentic Developer in $destinationPath"
Write-Output 'Open Magentic Developer from Start. No hosting, firewall change, or administrator permission is needed.'
