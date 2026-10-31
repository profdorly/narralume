param([string]$Label = "launcher")

$ErrorActionPreference = "Stop"
$portSetting = if ($env:LAPIS_PORT) { $env:LAPIS_PORT } else { $env:NARRALUME_PORT }
$port = if ($portSetting) { [int]$portSetting } else { 4317 }
try {
  $backup = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/system/backups" -ContentType "application/json" -Body (@{ label = $Label } | ConvertTo-Json) -TimeoutSec 60
  Write-Host "Backup completed: $($backup.databaseFile)"
  $backup
} catch {
  throw "Could not create a consistent backup. Start Lapis first. $($_.Exception.Message)"
}
