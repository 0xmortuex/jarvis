#Requires -Version 5.1
<#
.SYNOPSIS
  Stops and removes the "Jarvis" scheduled task created by install-autostart.ps1.

.DESCRIPTION
  No admin rights needed. Fails with an error if the task is not registered.
  Ending the task makes run-supervised.ps1 stop node within a second or two.
  Your Jarvis home folder (config, token, inbox) is left alone.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'Jarvis'

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  throw "No scheduled task named `"$TaskName`" is registered for this user."
}

Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Output "Stopped and removed scheduled task `"$TaskName`"."
