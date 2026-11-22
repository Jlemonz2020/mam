# 手动注册 Windows 计划任务（等价于 mam task install --time 09:00）
# 用法（管理员或普通用户均可）：
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-task.ps1 -ExePath "C:\MAM\mam.exe" -Time 09:00
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$Time = '09:00'
)

if (-not (Test-Path $ExePath)) { throw "找不到可执行文件：$ExePath" }

$action = New-ScheduledTaskAction -Execute $ExePath -Argument 'checkin --scheduled'
# 登录后触发 + 每日定时；StartWhenAvailable = 错过触发点后补跑
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'MAM-DailyCheckin' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已注册计划任务 MAM-DailyCheckin，每日 $Time 执行：$ExePath checkin --scheduled"
Write-Host "查看：Get-ScheduledTask -TaskName MAM-DailyCheckin"
Write-Host "删除：Unregister-ScheduledTask -TaskName MAM-DailyCheckin -Confirm:`$false"
