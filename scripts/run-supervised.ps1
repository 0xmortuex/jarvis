#Requires -Version 5.1
<#
.SYNOPSIS
  Runs `node <Entry> run`, restarts it after a failure, and stops it when the parent process goes away.

.DESCRIPTION
  This is what the "Jarvis" scheduled task runs (see install-autostart.ps1). You do not run it by hand.

  Two jobs Task Scheduler does not do on its own:
    * Restart: a non-zero exit from node is followed by a new start after RestartDelaySeconds.
      A clean exit (code 0) ends this script.
    * Stop: ending the task only kills the process Task Scheduler launched (this script's parent).
      This script notices within a second, stops node and exits, so nothing is left running.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Entry,
  [ValidateRange(1, 3600)][int]$RestartDelaySeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
$parent = Get-Process -Id $parentId
# Reading HasExited now opens a handle to the parent, so a recycled process id cannot fool the checks below.
if ($parent.HasExited) { throw "The parent process $parentId has already exited." }

while ($true) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Node
  $start.Arguments = "`"$Entry`" run"
  $start.UseShellExecute = $false
  $child = [System.Diagnostics.Process]::Start($start)

  while (-not $child.WaitForExit(1000)) {
    if ($parent.HasExited) {
      $child.Kill()
      exit 0
    }
  }
  if ($child.ExitCode -eq 0) { exit 0 }

  for ($waited = 0; $waited -lt $RestartDelaySeconds; $waited++) {
    if ($parent.HasExited) { exit 0 }
    Start-Sleep -Seconds 1
  }
}
