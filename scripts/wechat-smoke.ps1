#requires -Version 7.3
<# Run only in an ordinary Windows PowerShell session with local desktop access.
   This script does not run npm checks; run npm run typecheck and npm test first. #>
[CmdletBinding()]
param(
  [string]$Project = (Split-Path $PSScriptRoot -Parent),
  [string]$WechatIde = 'E:\Software\微信web开发者工具\wechatide.cmd',
  [ValidateSet('Validate', 'Poll', 'Restore')][string]$Mode = 'Validate',
  [string]$RunDirectory
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:Project = (Resolve-Path -LiteralPath $Project).Path
$script:Token = $env:DAYFLOW_WECHAT_CLI_TOKEN
$script:Pending = $false
$script:Sequence = 0
$script:State = $null
$artifactRoot = Join-Path $script:Project 'artifacts/wechat-smoke'
$activeFile = Join-Path $artifactRoot 'active-run.json'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

function Save-Json($Value, [string]$Path, [switch]$PreserveValues) {
  $json = ConvertTo-Json -InputObject $Value -Depth 100
  if ($script:Token -and -not $PreserveValues) { $json = $json.Replace($script:Token, '[REDACTED]') }
  [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}
function Save-State {
  Save-Json $script:State (Join-Path $script:RunDirectory 'state.json')
  Save-Json @{ runDirectory = $script:RunDirectory; pending = $script:Pending; restoreNeeded = $script:State.restoreNeeded } $activeFile
}
function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  $script:State.assertions += $Message
  Save-State
}
# The installed CLI emits {ok, result}; some tools also wrap result in body/data.
# Search only structural wrapper fields, and reject an unrecognised shape.
function Find-Object($Value, [string]$RequiredKey) {
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Contains($RequiredKey)) { return $Value }
    foreach ($key in @('result', 'body', 'data', 'value', 'detail', 'rawResult')) {
      if ($Value.Contains($key)) {
        $found = Find-Object $Value[$key] $RequiredKey
        if ($null -ne $found) { return $found }
      }
    }
    if ($Value.Contains('content')) {
      foreach ($part in $Value.content) {
        if ($part.type -eq 'text') {
          try { $parsed = ConvertFrom-Json -InputObject $part.text -AsHashtable -ErrorAction Stop } catch { continue }
          $found = Find-Object $parsed $RequiredKey
          if ($null -ne $found) { return $found }
        }
      }
    }
  }
  return $null
}
function Invoke-Ide([string]$Tool, [string[]]$ToolArguments = @(), [switch]$ProjectTool) {
  $script:Sequence++
  $arguments = @('-c', 'Codex', $Tool)
  if ($ProjectTool) { $arguments += @('--project', $script:Project) }
  $arguments += $ToolArguments
  if ($script:Token) { $arguments += @('--token', $script:Token) }
  # No command string, Invoke-Expression, transcript, or argument logging. The token
  # comes only from this process environment and is never written to artifacts.
  $raw = (& $WechatIde @arguments 2>&1 | Out-String)
  $nativeExit = $LASTEXITCODE
  $loggedRaw = $raw
  if ($script:Token) { $loggedRaw = $loggedRaw.Replace($script:Token, '[REDACTED]') }
  $name = '{0:D3}-{1}' -f $script:Sequence, $Tool
  [IO.File]::WriteAllText((Join-Path $script:RunDirectory "$name.log"), $loggedRaw, [Text.UTF8Encoding]::new($false))
  try { $reply = ConvertFrom-Json -InputObject $raw -AsHashtable -ErrorAction Stop }
  catch { throw "$Tool returned non-JSON output; inspect $name.log (exit $nativeExit)." }
  $pendingNode = Find-Object $reply 'taskId'
  if ($null -ne $pendingNode -and $pendingNode.status -eq 'pending') {
    $script:Pending = $true
    if ($Tool -eq 'polling_task_result' -and $null -ne $script:State.pendingTask) {
      $script:State.pendingTask.lastResponse = "$name.log"
    } else {
      $script:State.pendingTask = @{ taskId = $pendingNode.taskId; tool = $Tool; arguments = $ToolArguments; status = 'pending'; lastResponse = "$name.log" }
    }
    $script:State.outcome = 'pending'
    Save-State
    throw "Pending task $($pendingNode.taskId). Confirm in WeChat DevTools, then use -Mode Poll -RunDirectory this run. No action will be replayed."
  }
  if ($nativeExit -ne 0 -or $reply.ok -ne $true) {
    if ($Tool -eq 'polling_task_result') {
      $taskOutcome = Find-Object $reply 'status'
      if ($null -ne $taskOutcome -and $taskOutcome.status -in @('failed', 'cancelled', 'expired')) { return $taskOutcome }
    }
    throw "$Tool failed; inspect $name.log (exit $nativeExit)."
  }
  $failed = Find-Object $reply.result 'success'
  if ($null -ne $failed -and $failed.success -eq $false) { throw "$Tool reported failure; inspect $name.log." }
  return $reply.result
}
function Get-Page([string]$Selector) {
  $argsForPage = @('--action', 'getData')
  if ($Selector) { $argsForPage += @('--wait-for-selector', $Selector) }
  $reply = Invoke-Ide 'automation_page_action' $argsForPage -ProjectTool
  foreach ($key in @('selectedDate', 'dateKey', 'days', 'version')) {
    $page = Find-Object $reply $key
    if ($null -ne $page) { return $page }
  }
  throw 'Unrecognised getData response; cannot assert page state.'
}
function Tap([string]$Selector) {
  $null = Invoke-Ide 'automation_element_action' @('--selector', $Selector, '--action', 'tap', '--wait-for-selector', $Selector) -ProjectTool
}
function Navigate([string]$Action, [string]$Url = '') {
  $nav = @('--action', $Action)
  if ($Url) { $nav += @('--url', $Url) }
  $null = Invoke-Ide 'automation_navigate' $nav -ProjectTool
}
function Evaluate([string]$Source, $Arguments = @()) {
  $argFile = Join-Path $script:RunDirectory ('evaluate-args-' + [Guid]::NewGuid().ToString('N') + '.json')
  # Evaluation arguments can contain exact record backups. Never redact their
  # values: these local-only files are excluded from Git along with the backup.
  Save-Json @($Arguments) $argFile -PreserveValues
  $reply = Invoke-Ide 'automation_evaluate' @('--fn-source', $Source, '--args-file', $argFile) -ProjectTool
  $payload = Find-Object $reply 'dayflowSmoke'
  if ($null -eq $payload) { throw 'Unrecognised evaluate response; cannot confirm storage state.' }
  return $payload
}
function Record-State($Page, [string]$Id) {
  $matches = @($Page.blocks | ForEach-Object { $_.actions } | Where-Object { $_.id -eq $Id })
  if ($matches.Count -ne 1) { throw "Expected exactly one task $Id." }
  return [bool]$matches[0].done
}
function Local-DatePlus([string]$Key, [int]$Delta) {
  return [DateTime]::ParseExact($Key, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture).AddDays($Delta).ToString('yyyy-MM-dd')
}
function Restore-Records {
  $backupFile = Join-Path $script:RunDirectory 'records-backup.json'
  $backup = Get-Content -Raw -Encoding utf8 -LiteralPath $backupFile | ConvertFrom-Json -AsHashtable
  # Never clear storage. Restore only Dayflow's records key; unrelated keys stay intact.
  # If the key was absent, an empty object is semantically equivalent and avoids deletion.
  $source = "function(snapshot) { var value = snapshot.present ? snapshot.value : {}; wx.setStorageSync('dayflow.records.v1', value); var actual = wx.getStorageSync('dayflow.records.v1'); return {dayflowSmoke: true, equal: JSON.stringify(actual) === JSON.stringify(value)}; }"
  $result = Evaluate $source @($backup)
  Assert-That ($result.equal -eq $true) 'Original Dayflow records restored and read back'
  $script:State.restoreNeeded = $false
  Save-State
}

if (-not (Test-Path -LiteralPath $WechatIde -PathType Leaf)) { throw 'wechatide.cmd was not found; provide -WechatIde with the installed absolute path.' }
if ($Mode -eq 'Validate') {
  if (Test-Path -LiteralPath $activeFile) {
    $previous = Get-Content -Raw -LiteralPath $activeFile | ConvertFrom-Json -AsHashtable
    if ($previous.pending -or $previous.restoreNeeded) { throw "Previous run needs polling/restoration: $($previous.runDirectory). Do not start another test." }
  }
  if (-not $RunDirectory) { $RunDirectory = Join-Path $artifactRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)) }
  if (Test-Path -LiteralPath (Join-Path $RunDirectory 'state.json')) { throw 'Use a new run directory for Validate.' }
  New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
  $script:RunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State = @{ project = $script:Project; started = (Get-Date).ToString('o'); outcome = 'running'; restoreNeeded = $false; assertions = @(); pendingTask = $null; simulatorInteractionVerified = $false; consoleReviewRequired = $true; realDeviceVerified = $false }
} else {
  if (-not $RunDirectory) { throw 'Poll/Restore requires -RunDirectory from the paused run.' }
  $script:RunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State = Get-Content -Raw -LiteralPath (Join-Path $script:RunDirectory 'state.json') | ConvertFrom-Json -AsHashtable
  if ($script:State.project -ne $script:Project) { throw 'Backup belongs to another project.' }
  $script:Sequence = @(Get-ChildItem -LiteralPath $script:RunDirectory -Filter '*.log').Count
  $script:Pending = $null -ne $script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'
}
Save-State
$exitCode = 0
try {
  if ($Mode -eq 'Poll') {
    if (-not $script:Pending) { throw 'This run has no pending task.' }
    $taskId = $script:State.pendingTask.taskId
    $reply = Invoke-Ide 'polling_task_result' @('--task-id', $taskId)
    $terminal = Find-Object $reply 'status'
    if ($null -eq $terminal -or $terminal.status -notin @('success', 'failed', 'cancelled', 'expired')) { throw 'Unknown task status; do not replay or restore until resolved.' }
    $script:Pending = $false
    $script:State.pendingTask.status = $terminal.status
    $script:State.outcome = 'paused-' + $terminal.status
    Save-State
    Write-Host "Task $taskId is $($terminal.status). Original operation was not replayed. Restore records before starting a new test if restoreNeeded is true."
    if ($terminal.status -ne 'success') { $exitCode = 1 }
  } else {
    if ($script:Pending) { throw 'Pending approval must be resolved with -Mode Poll before restoration.' }
    $statusReply = Invoke-Ide 'check_wechatide_status' @('--skill-version', '0.3.11')
    $status = Find-Object $statusReply 'versionRelation'
    if ($null -eq $status -or $status.versionRelation -notin @('equal', 'agent_ahead') -or $status.loginExpired -ne $false) { throw 'Version/login gate failed. Update the agent skill or log in using DevTools; no test was started.' }
    if (($status.cliTokenRequired -or $status.tokenRequired) -and -not $script:Token) { throw 'Set DAYFLOW_WECHAT_CLI_TOKEN to the CLI access token from DevTools Settings > Security. Do not paste it into project files.' }
    $null = Invoke-Ide 'open_project_window' @('--window-mode', 'fullMode') -ProjectTool
    if ($Mode -eq 'Restore') {
      if (-not $script:State.restoreNeeded) { throw 'No outstanding records restoration.' }
      Restore-Records
      $script:State.outcome = 'restored'
    } else {
      $config = Get-Content -Raw -Encoding utf8 (Join-Path $script:Project 'project.config.json') | ConvertFrom-Json -AsHashtable
      if ($config.compileType -ne 'miniprogram') { throw 'Expected a native miniprogram project.' }
      $appRoot = Join-Path $script:Project $config.miniprogramRoot
      $appConfig = Get-Content -Raw -Encoding utf8 (Join-Path $appRoot 'app.json') | ConvertFrom-Json -AsHashtable
      foreach ($pagePath in $appConfig.pages) {
        $null = Invoke-Ide 'compile_wxml' @('--file-path', "$pagePath.wxml") -ProjectTool
        $null = Invoke-Ide 'compile_wxss' @('--file-path', "$pagePath.wxss") -ProjectTool
      }
      $null = Invoke-Ide 'simulator_open_page' @('--page', 'pages/today/index') -ProjectTool
      $todayPage = Get-Page '.weekday'
      $null = Invoke-Ide 'simulator_screenshot' @('--path', (Join-Path $script:RunDirectory 'today.png'), '--optimize=false', '--wait-for-selector', '.weekday') -ProjectTool
      $today = $todayPage.selectedDate
      $week = @($todayPage.week | ForEach-Object { $_.date })
      Assert-That ($week.Count -eq 7 -and $todayPage.isToday -eq $true) 'Today opens with seven dates and today selected'
      $snapshot = Evaluate "function() { var present = wx.getStorageInfoSync().keys.indexOf('dayflow.records.v1') !== -1; return {dayflowSmoke: true, present: present, value: present ? wx.getStorageSync('dayflow.records.v1') : null}; }"
      Save-Json $snapshot (Join-Path $script:RunDirectory 'records-backup.json') -PreserveValues
      $script:State.restoreNeeded = $true
      Save-State
      foreach ($date in $week) {
        Tap ".weekday[data-date='$date']"
        $page = Get-Page '.weekday'
        Assert-That ($page.selectedDate -eq $date -and @($page.week | Where-Object { $_.selected }).Count -eq 1) "Date $date can be selected"
      }
      Tap ".week-arrow[data-delta='1']"
      $page = Get-Page '.weekday'
      Assert-That ($page.selectedDate -eq (Local-DatePlus $week[6] 7)) 'Next week advances exactly seven local calendar days'
      Tap ".week-arrow[data-delta='-1']"
      $page = Get-Page '.weekday'
      Assert-That ($page.selectedDate -eq $week[6]) 'Previous week returns to the selected local date'
      Tap ".weekday[data-date='$today']"
      $before = Get-Page '.block-header'
      $guitarBefore = Record-State $before 'music-guitar'
      $vocalBefore = Record-State $before 'music-vocal'
      $otherDate = @($week | Where-Object { $_ -ne $today })[0]
      Tap ".weekday[data-date='$otherDate']"
      $otherBefore = Get-Page '.weekday'
      $otherGuitarBefore = Record-State $otherBefore 'music-guitar'
      Tap ".weekday[data-date='$today']"
      Tap ".block-header[data-id='music']"
      Tap ".check-button[data-id='music-guitar']"
      $after = Get-Page '.check-button'
      Assert-That ((Record-State $after 'music-guitar') -ne $guitarBefore) 'Guitar checkbox changes its own state'
      Assert-That ((Record-State $after 'music-vocal') -eq $vocalBefore) 'Parallel vocal task stays unchanged'
      Tap ".weekday[data-date='$otherDate']"
      $otherAfter = Get-Page '.weekday'
      Assert-That ((Record-State $otherAfter 'music-guitar') -eq $otherGuitarBefore) 'Other date keeps its independent record'
      Tap ".weekday[data-date='$today']"
      $page = Get-Page '.weekday'
      Assert-That ((Record-State $page 'music-guitar') -ne $guitarBefore) 'Switching back retains the changed record'
      Tap ".block-header[data-id='training']"
      Tap ".detail-link[data-id='training']"
      $training = Get-Page '.exercise'
      $null = Invoke-Ide 'simulator_screenshot' @('--path', (Join-Path $script:RunDirectory 'training.png'), '--optimize=false', '--wait-for-selector', '.exercise') -ProjectTool
      Assert-That ($training.dateKey -eq $today -and @($training.actions).Count -gt 0) 'Training details match the selected date'
      $action = @($training.actions)[0]
      $actionId = $action.id
      $actionDone = [bool]$action.done
      Tap ".check[data-id='$actionId']"
      $trainingAfter = Get-Page '.exercise'
      $changed = @($trainingAfter.actions | Where-Object { $_.id -eq $actionId })
      Assert-That ($changed.Count -eq 1 -and [bool]$changed[0].done -ne $actionDone) 'Training action checkbox changes its state'
      Navigate 'navigateBack'
      $returned = Get-Page '.weekday'
      Assert-That ((Record-State $returned $actionId) -ne $actionDone) 'Returning from training refreshes timeline completion'
      foreach ($tab in @(@{ route = 'plans'; key = 'days' }, @{ route = 'stats'; key = 'days' }, @{ route = 'profile'; key = 'version' })) {
        Navigate 'switchTab' ("/pages/" + $tab.route + '/index')
        $tabPage = Get-Page ''
        Assert-That ($tabPage.Contains($tab.key)) ("Tab loads page data: " + $tab.route)
      }
      Navigate 'switchTab' '/pages/today/index'
      $page = Get-Page '.weekday'
      Assert-That ($page.selectedDate -eq $today -and (Record-State $page 'music-guitar') -ne $guitarBefore) 'Today Tab retains saved task state'
      $console = Invoke-Ide 'get_simulator_console' @('--command', 'grep -i error') -ProjectTool
      Save-Json $console (Join-Path $script:RunDirectory 'console-errors.json')
      # Console output remains evidence for review: DevTools may include unrelated
      # platform warnings. A successful refresh alone is never counted as a pass.
      $script:State.outcome = 'interaction-pass-console-review-required'
      $script:State.simulatorInteractionVerified = $true
    }
  }
} catch {
  $exitCode = 1
  if (-not $script:Pending) { $script:State.outcome = 'failed' }
  $message = $_.Exception.Message
  if ($script:Token) { $message = $message.Replace($script:Token, '[REDACTED]') }
  $script:State.error = $message
  Write-Warning $message
} finally {
  if ($Mode -eq 'Validate' -and $script:State.restoreNeeded -and -not $script:Pending) {
    try { Restore-Records } catch {
      $exitCode = 1
      $script:State.outcome = 'restoration-required'
      Write-Warning 'Records restoration did not complete. Keep this run directory and use -Mode Poll/Restore as documented.'
    }
  }
  $script:State.finished = (Get-Date).ToString('o')
  Save-State
  Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
