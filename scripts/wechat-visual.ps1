#requires -Version 7.3
[CmdletBinding()]
param([string]$Project=(Split-Path $PSScriptRoot -Parent),[string]$WechatIde='E:\Software\微信web开发者工具\wechatide.cmd',[ValidateSet('default','narrow')][string]$Label='default',[switch]$VerifyNavigation,[string]$RestoreRunDirectory)
$ErrorActionPreference='Stop';$PSNativeCommandUseErrorActionPreference=$false
$script:Project=(Resolve-Path -LiteralPath $Project).Path;$script:Token=$env:DAYFLOW_WECHAT_CLI_TOKEN;$script:Pending=$false;$script:Sequence=0
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'wechat-smoke.ps1'),[ref]$null,[ref]$errors)
if($errors.Count){throw 'Smoke helper syntax error.'}
foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
$root=Join-Path $script:Project 'artifacts/wechat-visual';New-Item -ItemType Directory -Path $root -Force|Out-Null
$activeFile=Join-Path $root 'active-run.json'
$sources=$null
if($RestoreRunDirectory){
  $script:RunDirectory=(Resolve-Path -LiteralPath $RestoreRunDirectory).Path
  $script:State=Get-Content (Join-Path $script:RunDirectory 'state.json') -Raw|ConvertFrom-Json -AsHashtable
  if($script:State.project -ne $script:Project){throw 'Visual backup project mismatch.'}
  $script:Sequence=@(Get-ChildItem $script:RunDirectory -Filter '*.log').Count
  $script:Pending=$null -ne $script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'
  $sources=(& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js')|Out-String)|ConvertFrom-Json -AsHashtable
}else{
  if(Test-Path $activeFile){$old=Get-Content $activeFile -Raw|ConvertFrom-Json;if($old.pending -or $old.restoreNeeded){throw 'Previous visual run requires recovery before another capture.'}}
  $script:RunDirectory=Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$Label);New-Item -ItemType Directory -Path $script:RunDirectory -Force|Out-Null
  $script:State=@{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';restoreNeeded=$false;assertions=@();pendingTask=$null;realDeviceVerified=$false}
}
Save-State;$exitCode=0
function Restore-VisualStorage {
  $snapshot=Get-Content (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -Raw -Encoding utf8|ConvertFrom-Json -AsHashtable
  $restored=Evaluate ($sources.restore -replace '\r?\n',' ') @($snapshot)
  Assert-That ($restored.equal -eq $true) 'Visual navigation restores all Dayflow values and key existence'
}
function Wait-VisualToday {
  $stableId=$null
  for($attempt=0;$attempt -lt 5;$attempt++){
    try{
      $before=Find-Object (Invoke-Ide 'automation_runtime_info' @('--action','currentPage') -ProjectTool) 'currentPage'
      if($null -eq $before.currentPage -or $before.currentPage.path.TrimStart('/') -ne 'pages/today/index'){$stableId=$null;continue}
      if($null -eq $before.currentPage.pageId){throw 'Cannot verify the visible page instance without a pageId.'}
      $data=Get-Page '.today-jump'
      $after=Find-Object (Invoke-Ide 'automation_runtime_info' @('--action','currentPage') -ProjectTool) 'currentPage'
      if($null -eq $after.currentPage -or $after.currentPage.pageId -ne $before.currentPage.pageId -or -not $data.selectedDate){$stableId=$null;continue}
      if($stableId -eq $after.currentPage.pageId){Assert-That $true 'Current Today page instance and visible navigation are stable';return}
      $stableId=$after.currentPage.pageId
    }catch{
      $message=$_.Exception.Data['ToolMessage']
      if($_.Exception.Data['ToolErrorType'] -eq 'MCP_TOOL_ERROR' -and ($message -eq 'timeout waiting for automator response' -or $message -eq 'waitForSelector timeout: .today-jump: page is not on top of page stack')){$stableId=$null;continue}
      throw
    }
  }
  throw 'Today view did not stabilize after five read-only observations; no navigation click was retried.'
}
try{
  $status=Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
  if($null -eq $status -or $status.versionRelation -notin @('equal','agent_ahead') -or $status.loginExpired -ne $false){throw 'DevTools version/login gate failed.'}
  if(($status.cliTokenRequired -or $status.tokenRequired) -and -not $script:Token){throw 'CLI token required; no credentials were read.'}
  if($RestoreRunDirectory){
    if($script:Pending){throw 'Resolve the original pending task before restoring visual data.'}
    $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
    $null=Invoke-Ide 'simulator_open_page' @('--page','pages/today/index') -ProjectTool
    Wait-VisualToday
    Restore-VisualStorage;Tap '.today-jump';$data=Get-Page '.weekday';Assert-That ($data.selectedDate -eq (Get-Date).ToString('yyyy-MM-dd')) 'Visual recovery returns to the real date'
    Restore-VisualStorage;$script:State.restoreNeeded=$false;$script:State.originalInterfaceRestored=$true;$script:State.outcome='restored'
  }else{
  $runtime=Invoke-Ide 'automation_runtime_info' @('--action','currentPage') -ProjectTool
  $page=Find-Object $runtime 'currentPage';if($page.currentPage.path -ne 'pages/today/index'){throw 'Return to the real Today page before read-only visual capture.'}
  if($VerifyNavigation){
    $sources=(& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js')|Out-String)|ConvertFrom-Json -AsHashtable
    $snapshot=Evaluate ($sources.backup -replace '\r?\n',' ') @($sources.keys)
    Save-Json $snapshot (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -PreserveValues
    $script:State.restoreNeeded=$true;Save-State
    $null=Invoke-Ide 'compile_wxml' @('--file-path','pages/today/index.wxml') -ProjectTool
    $null=Invoke-Ide 'compile_wxss' @('--file-path','pages/today/index.wxss') -ProjectTool
    $null=Invoke-Ide 'simulator_open_page' @('--page','pages/today/index') -ProjectTool
    Wait-VisualToday;Tap '.today-jump';$today=(Get-Date).ToString('yyyy-MM-dd');$data=Get-Page '.weekday'
    Assert-That ($data.selectedDate -eq $today -and @($data.week).Count -eq 7) 'Styled Today opens on the real local date with seven days'
    $other=@($data.week|Where-Object {$_.date -ne $today})[0].date
    Tap ".weekday[data-date='$other']";$data=Get-Page '.weekday';Assert-That ($data.selectedDate -eq $other) 'Styled weekday target remains clickable'
    Tap ".week-arrow[data-delta='-1']";$data=Get-Page '.weekday';Assert-That ($data.selectedDate -eq (Local-DatePlus $other -7)) 'Styled previous-week button moves back seven days'
    Tap ".week-arrow[data-delta='1']";$data=Get-Page '.weekday';Assert-That ($data.selectedDate -eq $other) 'Styled next-week button moves forward seven days'
    Tap '.today-jump';$data=Get-Page '.weekday';Assert-That ($data.selectedDate -eq $today) 'Styled Today button returns to the real date'
    $null=Invoke-Ide 'automation_viewport_action' @('--action','pageScrollTo','--scroll-top','0') -ProjectTool
  }
  $info=Invoke-Ide 'automation_runtime_info' @('--action','systemInfo') -ProjectTool
  Save-Json $info (Join-Path $script:RunDirectory 'system-info.local.json')
  foreach($selector in @('.today-jump','.week-arrow','.weekday','.block-header')){
    $size=Invoke-Ide 'automation_element_action' @('--selector',$selector,'--action','size') -ProjectTool
    Save-Json $size (Join-Path $script:RunDirectory (($selector.TrimStart('.'))+'-size.json'))
  }
  $null=Invoke-Ide 'simulator_screenshot' @('--path',(Join-Path $script:RunDirectory ($Label+'-today.png')),'--optimize=false','--wait-for-selector','.weekday') -ProjectTool
  $script:State.outcome='visual-evidence-collected';$script:State.label=$Label
  }
}catch{$exitCode=1;$script:State.error=$_.Exception.Message;$script:State.outcome='failed';Write-Warning $_.Exception.Message}
finally{
  if($script:State.restoreNeeded -and -not $script:Pending){
    try{
      Restore-VisualStorage;Tap '.today-jump';$data=Get-Page '.weekday';Assert-That ($data.selectedDate -eq (Get-Date).ToString('yyyy-MM-dd')) 'Visual interface returns to today using original data'
      $null=Invoke-Ide 'automation_viewport_action' @('--action','pageScrollTo','--scroll-top','0') -ProjectTool
      Restore-VisualStorage;$script:State.restoreNeeded=$false;$script:State.originalInterfaceRestored=$true
    }catch{$exitCode=1;$script:State.outcome='restoration-required';$script:State.restoreNeeded=$true;$script:State.error=$_.Exception.Message}
  }
  $script:State.finished=(Get-Date).ToString('o');Save-State;Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
