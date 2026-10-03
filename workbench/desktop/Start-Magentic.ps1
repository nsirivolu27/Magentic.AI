$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object System.Threading.Mutex($false, "Local\MagenticDeveloper-$identity")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Magentic Developer is already running. Switch to its application window.' }
    $data = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MagenticDeveloper\data'
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $runtime = Join-Path $PSScriptRoot 'runtime\node.exe'
    $entry = Join-Path $PSScriptRoot 'launcher.mjs'
    $app = Start-Process -FilePath $runtime -ArgumentList @('"' + $entry + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $data 'app.log') -RedirectStandardError (Join-Path $data 'error.log')
    if ($app.ExitCode -ne 0) { throw "Magentic could not start. See $data\error.log for details." }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Magentic Developer') | Out-Null
    exit 1
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
