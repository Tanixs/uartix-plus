# 从 Trae 本地历史恢复被 Fast Apply 覆写的文件（-Restore 执行复制，否则干跑）
param([switch]$Restore)
$ErrorActionPreference = "Stop"
$hist = "C:\Users\Firs\AppData\Roaming\Trae CN\User\History"
$targets = [ordered]@{
  "-20b95dc7" = "d:\Projects\Larix-Visual-Serial\src\features\console\ConsolePanel.tsx"
  "-291fd4bd" = "d:\Projects\Larix-Visual-Serial\src\features\plot\Plot2D.tsx"
  "-30a86dce" = "d:\Projects\Larix-Visual-Serial\src\features\help\HelpModal.tsx"
  "-37342ede" = "d:\Projects\Larix-Visual-Serial\src\features\controls\scriptRunner.ts"
  "-547be3dd" = "d:\Projects\Larix-Visual-Serial\HANDOFF.md"
  "-5ab9ad39" = "d:\Projects\Larix-Visual-Serial\src\features\controls\commandStore.ts"
  "-5d482f47" = "d:\Projects\Larix-Visual-Serial\src\features\controls\CardViews.tsx"
  "-78e2c6f0" = "d:\Projects\Larix-Visual-Serial\src\features\controls\ControlCanvas.tsx"
  "34518b1a"  = "d:\Projects\Larix-Visual-Serial\src\styles\theme.css"
  "3b2c7b98"  = "d:\Projects\Larix-Visual-Serial\src\features\controls\variableStore.ts"
  "4f6ebbd"   = "d:\Projects\Larix-Visual-Serial\src\features\attitude\View3D.tsx"
  "53b06432"  = "d:\Projects\Larix-Visual-Serial\src\features\plot\plotStore.ts"
  "5a9e4072"  = "d:\Projects\Larix-Visual-Serial\src\features\settings\settingsStore.ts"
  "60754533"  = "d:\Projects\Larix-Visual-Serial\src\i18n\strings.ts"
  "6949f2"    = "d:\Projects\Larix-Visual-Serial\src\features\settings\SettingsModal.tsx"
  "6af50623"  = "d:\Projects\Larix-Visual-Serial\src\features\video\VideoLink.tsx"
}
foreach ($kv in $targets.GetEnumerator()) {
  $dir = $kv.Key; $target = $kv.Value
  $entriesPath = Join-Path $hist "$dir\entries.json"
  if (-not (Test-Path $entriesPath)) { Write-Output "MISSING entries: $dir"; continue }
  $raw = Get-Content $entriesPath -Raw
  $list = [regex]::Matches($raw, '"id":"([^"]+)"[^{}]*?"timestamp":(\d+)')
  if ($list.Count -eq 0) { Write-Output "NO ENTRIES: $dir"; continue }
  $sorted = @($list | Sort-Object { [long]$_.Groups[2].Value })
  $fast = $sorted | Where-Object { $_.Value -like "*Fast Apply*" } | Select-Object -Last 1
  if (-not $fast) { Write-Output "NO FAST APPLY: $dir"; continue }
  $fastTs = [long]$fast.Groups[2].Value
  $pre = $sorted | Where-Object { [long]$_.Groups[2].Value -lt $fastTs } | Select-Object -Last 1
  if (-not $pre) { Write-Output "NO PRE SNAPSHOT: $dir"; continue }
  $snap = Join-Path $hist "$dir\$($pre.Groups[1].Value)"
  $fastSnap = Join-Path $hist "$dir\$($fast.Groups[1].Value)"
  $snapSize = (Get-Item $snap).Length
  $fastSize = (Get-Item $fastSnap).Length
  $pdt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$pre.Groups[2].Value).LocalDateTime.ToString("MM-dd HH:mm:ss")
  $sameAsFast = (Get-FileHash $target).Hash -eq (Get-FileHash $fastSnap).Hash
  if ($Restore) {
    Copy-Item $snap $target -Force
    Write-Output "RESTORED: $target <= $($pre.Groups[1].Value)@$pdt"
  } else {
    Write-Output "$dir => pre=$($pre.Groups[1].Value)@$pdt ${snapSize}B | fast=${fastSize}B | disk==fast:$sameAsFast | $target"
  }
}
