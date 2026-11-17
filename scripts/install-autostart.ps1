#Requires -Version 5.1
<#
.SYNOPSIS
  Registers a per-user Task Scheduler task "Jarvis" that runs `node bin/jarvis.js run` at logon.

.DESCRIPTION
  No admin rights needed: the task belongs to the current user and runs with normal rights.

  The task starts conhost.exe in headless mode, so no window is ever shown. Inside it
  run-supervised.ps1 runs node, starts it again after any non-zero exit, and stops it when the
  task is ended. That script does the restarting because Task Scheduler's own "restart on
  failure" does not fire when the program exits with an error code, and because headless
  conhost always reports exit code 0. A clean exit (code 0) ends it.

  node and the repo are written into the task as absolute paths. Run this script again after
  moving the repo or reinstalling Node; it replaces the existing task.

.PARAMETER DryRun
  Print the task definition as JSON and register nothing.
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'Jarvis'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $repo 'bin\jarvis.js'
$supervisor = Join-Path $PSScriptRoot 'run-supervised.ps1'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($file in @($entry, $supervisor, $conhost, $powershell)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Cannot find $file" }
}

$arguments = "--headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
  "-File `"$supervisor`" -Node `"$node`" -Entry `"$entry`""
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($DryRun) {
  [pscustomobject]@{
    taskName         = $TaskName
    user             = $user
    execute          = $conhost
    arguments        = $arguments
    workingDirectory = $repo
    node             = $node
    entry            = $entry
    supervisor       = $supervisor
  } | ConvertTo-Json
  return
}

$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# No time limit: the default would kill the daemon after 72 hours.
# IgnoreNew: starting the task twice must not start a second daemon on the same port.
# RestartCount covers the case Task Scheduler does see: the action could not be launched at all.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Jarvis heartbeat and local server (node bin/jarvis.js run).' -Force | Out-Null

Write-Output "Registered scheduled task `"$TaskName`" for $user."
Write-Output "  node: $node"
Write-Output "  repo: $repo"
Write-Output "It starts at your next logon. To start it now: Start-ScheduledTask -TaskName $TaskName"
