param([string]$Destination, [switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
if (-not $Destination) { $Destination = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MagenticDeveloper\application' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'The destination already exists. Choose a new directory; existing installations are never overwritten.' }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MagenticDeveloper'
if (Test-Path -LiteralPath $key) { throw 'Magentic Developer is already listed in Apps & features. Uninstall that copy first; installations are never replaced in place.' }
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
# Apps & features entry, so the application can be removed the usual way.
# Everything stays under the current user; no administrator rights are used.
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'version.json') -Raw | ConvertFrom-Json).version
$uninstall = '"' + (Join-Path $PSHOME 'powershell.exe') + '" -NoProfile -File "' + (Join-Path $destinationPath 'Uninstall.ps1') + '"'
$sizeKb = [int]((Get-ChildItem -LiteralPath $destinationPath -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -LiteralPath $key -Name 'DisplayName' -Value 'Magentic Developer'
Set-ItemProperty -LiteralPath $key -Name 'DisplayVersion' -Value $version
Set-ItemProperty -LiteralPath $key -Name 'Publisher' -Value 'Magentic'
Set-ItemProperty -LiteralPath $key -Name 'InstallLocation' -Value $destinationPath
Set-ItemProperty -LiteralPath $key -Name 'UninstallString' -Value $uninstall
Set-ItemProperty -LiteralPath $key -Name 'InstallDate' -Value (Get-Date -Format 'yyyyMMdd')
Set-ItemProperty -LiteralPath $key -Name 'EstimatedSize' -Value $sizeKb -Type DWord
Set-ItemProperty -LiteralPath $key -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -LiteralPath $key -Name 'NoRepair' -Value 1 -Type DWord
Write-Output "Installed Magentic Developer $version in $destinationPath"
Write-Output 'Open Magentic Developer from Start. No hosting, firewall change, or administrator permission is needed.'
