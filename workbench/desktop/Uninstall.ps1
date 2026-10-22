param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'
# Refuse while the application runs; its launcher holds this per-user mutex.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object System.Threading.Mutex($false, "Local\MagenticDeveloper-$identity")
try {
    try { $running = -not $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $running = $false }
    if ($running) { throw 'Close Magentic Developer before uninstalling it.' }
    $mutex.ReleaseMutex()
} finally { $mutex.Dispose() }
$application = [IO.Path]::GetFullPath($PSScriptRoot)
# Only an installed package directory is removed; a stray copy of this script
# elsewhere must not delete whatever folder it happens to be in.
foreach ($required in @('version.json', 'launcher.mjs', 'Start-Magentic.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $application $required))) { throw "This is not a Magentic Developer installation: $application" }
}
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Magentic Developer.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MagenticDeveloper'
if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse }
$data = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MagenticDeveloper\data'
if ($RemoveData -and (Test-Path -LiteralPath $data)) { Remove-Item -LiteralPath $data -Recurse -Force }
# Leave the directory before deleting it; the script itself is already loaded.
Set-Location ([IO.Path]::GetTempPath())
Remove-Item -LiteralPath $application -Recurse -Force
Write-Output "Removed Magentic Developer from $application"
if ($RemoveData) { Write-Output 'Saved workspaces, browser profile and logs were removed as well.' }
else { Write-Output "Saved workspaces, browser profile and logs remain in $data. Run Uninstall.ps1 -RemoveData to delete them." }
