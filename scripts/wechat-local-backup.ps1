#requires -Version 7.3
<# Run only in the ordinary Windows host, never a sandbox. Native file choice,
   share and confirmation callbacks are controlled; no message is really sent. #>
[CmdletBinding()]
param(
  [string]$Project=(Split-Path $PSScriptRoot -Parent),
  [string]$WechatIde='E:\Software\微信web开发者工具\wechatide.cmd',
  [ValidateSet('Validate','Layout','Restore','Poll')][string]$Mode='Validate',
  [ValidateSet('default','narrow')][string]$Label='default',
  [string]$RunDirectory
)
$script:OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop';$PSNativeCommandUseErrorActionPreference=$false
$script:Project=(Resolve-Path -LiteralPath $Project).Path;$script:Token=$null;$script:Pending=$false;$script:Sequence=0
foreach($helper in @('wechat-smoke.ps1','wechat-ux.ps1','wechat-planning-wizard.ps1')){
  $errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $helper),[ref]$null,[ref]$errors)
  if($errors.Count){throw 'Acceptance helper syntax error.'}
  foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
    if($helper -eq 'wechat-smoke.ps1' -or
       ($helper -eq 'wechat-ux.ps1' -and $fn.Name -in @('Ux-Page','Wait-UxPage','Ux-Shot','Ux-Measure','Ux-RestoreInterface')) -or
       ($helper -eq 'wechat-planning-wizard.ps1' -and $fn.Name -in @('Wz-Manifest','Get-RestoreTextHash','Split-RestoreText','Ux-RestoreAll'))){. ([scriptblock]::Create($fn.Extent.Text))}
  }
}
$artifactRoot=Join-Path $script:Project 'artifacts/wechat-local-backup';$activeFile=Join-Path $artifactRoot 'active-run.json'
New-Item -ItemType Directory -Path $artifactRoot -Force|Out-Null
if($Mode -in @('Restore','Poll')){
  if(-not $RunDirectory){throw 'Recovery requires the original RunDirectory.'}
  $script:RunDirectory=(Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State=Get-Content -LiteralPath (Join-Path $script:RunDirectory 'state.json') -Raw -Encoding utf8|ConvertFrom-Json -AsHashtable
  if($script:State.project -ne $script:Project){throw 'Backup project mismatch.'}
  if($Mode -eq 'Restore' -and -not $script:State.restoreNeeded){throw 'No outstanding recovery; never overwrite newer user data with an old backup.'}
  $script:Sequence=@(Get-ChildItem -LiteralPath $script:RunDirectory -Filter '*.log').Count
  $script:Pending=$null -ne $script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'
}else{
  # Every current and historical entry point must finish its own recovery first.
  foreach($marker in Get-ChildItem -LiteralPath (Join-Path $script:Project 'artifacts') -Filter active-run.json -Recurse -File){
    $previous=Get-Content -LiteralPath $marker.FullName -Raw -Encoding utf8|ConvertFrom-Json
    if($previous.pending -or $previous.restoreNeeded){throw 'Resolve the active task and restore its data before a new local-backup run.'}
  }
  if(-not $RunDirectory){$RunDirectory=Join-Path $artifactRoot ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$Label+'-'+$Mode.ToLowerInvariant())}
  if(Test-Path -LiteralPath (Join-Path $RunDirectory 'state.json')){throw 'Use a new run directory.'}
  New-Item -ItemType Directory -Path $RunDirectory -Force|Out-Null;$script:RunDirectory=(Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State=@{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';mode=$Mode;label=$Label;restoreNeeded=$false;storageRestored=$false;fileCleanupNeeded=$false;harnessInstalled=$false;nonce=[guid]::NewGuid().ToString('N');backupBeforeNames=@();fileManifest=@();assertions=@();pendingTask=$null;nativeFilePickerVerified=$false;nativeShareVerified=$false;nativeConfirmationVerified=$false;controlledFileChoice=$true;controlledShare=$true;controlledConfirmation=$true;realDeviceVerified=$false;cloudVerified=$false}
}
$sources=(& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js')|Out-String)|ConvertFrom-Json -AsHashtable
if($LASTEXITCODE -ne 0){throw 'Backup helper generation failed.'}
$restoreSources=(& node (Join-Path $PSScriptRoot 'acceptance-restore-transport.js')|Out-String)|ConvertFrom-Json -AsHashtable
if($LASTEXITCODE -ne 0 -or $restoreSources.maxChunk -ne 8192){throw 'Restore transport helper generation failed.'}
$sourceMode=if($Mode -in @('Restore','Poll')){@('--sources-only')}else{@()}
$backupSources=(& node (Join-Path $PSScriptRoot 'local-backup-acceptance-fixtures.js') (Get-Date).ToString('yyyy-MM-dd') $script:State.nonce @sourceMode|Out-String)|ConvertFrom-Json -AsHashtable
if($LASTEXITCODE -ne 0 -or ($Mode -notin @('Restore','Poll') -and $backupSources.payload.original.values['dayflow.plans.v1'].id -ne ('local-backup-acceptance-'+$script:State.nonce))){throw 'Local backup fixture generation or UTF-8 decoding failed.'}

function Bk-Evaluate([string]$Name,$Arguments=@()) { return Evaluate ($backupSources[$Name] -replace '\r?\n',' ') $Arguments }
function Bk-Page { return Ux-Page '.local-backup-toggle' 'backupBusy' }
function Bk-Idle {
  for($attempt=0;$attempt -lt 5;$attempt++){$page=Bk-Page;if(-not $page.backupBusy){return $page}}
  throw 'The backup action did not finish after bounded read-only observations; no tap was replayed.'
}
function Bk-Configure([string]$Choice='',[Nullable[bool]]$Confirm=$null,[string]$Fault=''){
  $input=@{nonce=$script:State.nonce}
  if($Choice){$input.choice=$Choice};if($null -ne $Confirm){$input.confirm=[bool]$Confirm};if($Fault){$input.fault=$Fault}
  $result=Bk-Evaluate 'setHarness' @($input);Assert-That $result.configured 'Controlled callback selection is explicitly configured'
}
function Bk-Snapshot { return Bk-Evaluate 'snapshotStorage' }
function Bk-Equal($Before,$After,[string]$Message){Assert-That ($Before.text -eq $After.text) $Message}
function Bk-BusinessEqual($Before,$After,[string]$Message){
  foreach($key in @('dayflow.plans.v1','dayflow.planVersions.v1','dayflow.instances.v1','dayflow.records.v1','dayflow.records.v2','dayflow.preferences.v1','dayflow.restDays.v1','dayflow.media.v1','dayflow.acceptanceSentinel.v1')){
    Assert-That (($Before.values.ContainsKey($key) -eq $After.values.ContainsKey($key)) -and ((ConvertTo-Json -InputObject $Before.values[$key] -Depth 100 -Compress) -eq (ConvertTo-Json -InputObject $After.values[$key] -Depth 100 -Compress))) ($Message+': '+$key)
  }
}
function Bk-Open {
  $null=Invoke-Ide 'automation_navigate' @('--action','reLaunch','--url','/pages/profile/index') -ProjectTool
  $null=Wait-UxPage 'pages/profile/index' '.section-data' 'expandedSection'
  Tap '.section-data';Tap '.local-backup-toggle';$page=Bk-Idle
  Assert-That ($page.expandedSection -eq 'data' -and $page.localBackupVisible) 'The actual data section opens local record backup on demand'
  return $page
}
function Bk-Seed([string]$Scenario='original'){
  $result=Bk-Evaluate 'seedValues' @(@{nonce=$script:State.nonce;values=$backupSources.payload[$Scenario].values})
  Assert-That $result.seeded ('Synthetic local-backup scenario installed: '+$Scenario)
  return Bk-Open
}
function Bk-Import([string]$File='incoming.json'){
  Bk-Configure -Choice $File;Tap '.backup-import';return Bk-Idle
}
function Bk-Layout([string]$Name,[string]$Anchor,[string[]]$Controls){
  $boxes=Ux-Measure $Name (@($Anchor)+$Controls)
  foreach($i in 1..($boxes.rects.Count-1)){foreach($rect in @($boxes.rects[$i])){Assert-That ($rect.width -ge 44 -and $rect.height -ge 44) ('At least 44px backup control: '+$Controls[$i-1])}}
  Ux-Shot $Name $Anchor
}
function Bk-Discover {
  $result=Bk-Evaluate 'discoverFiles' @(@{nonce=$script:State.nonce;before=@($script:State.backupBeforeNames);known=@($script:State.fileManifest)})
  $script:State.fileManifest=@($result.files);Save-State
  Save-Json @{nonce=$script:State.nonce;files=$script:State.fileManifest} (Join-Path $script:RunDirectory 'synthetic-file-manifest.local.json')
  return @($result.files)
}
function Bk-ExportAndPreview {
  $null=Bk-Seed;$before=Bk-Snapshot
  Tap '.backup-export';$page=Bk-Idle
  Assert-That ($page.backupExportReady -and $page.backupExportSummary.recordCount -ge 1) 'The actual export button writes and reads back a synthetic record backup file'
  $files=@(Bk-Discover);Assert-That (@($files|Where-Object {$_.kind -eq 'dayflow-local-record-backup'}).Count -eq 1) 'Exactly one newly generated nonce-owned export file is recorded for cleanup'
  $harness=Bk-Evaluate 'inspectHarness' @($script:State.nonce);Assert-That ($harness.shares -eq 0) 'Generating a backup never starts file sharing automatically'
  Bk-Equal $before (Bk-Snapshot) 'Export is read-only for every Dayflow business value'
  Tap '.backup-share';$null=Bk-Idle;$harness=Bk-Evaluate 'inspectHarness' @($script:State.nonce)
  Assert-That ($harness.shares -eq 1) 'Only an independent user-action button invokes the controlled share callback; no file is really sent'
  Bk-Equal $before (Bk-Snapshot) 'Controlled sharing changes no business value'
  Bk-Layout 'backup-export' '.local-backup-panel' @('.backup-export','.backup-import','.backup-share')
  $page=Bk-Import 'cancel';Assert-That (-not $page.backupPreviewSummary) 'Cancelling controlled file choice creates no pending restoration'
  Bk-Equal $before (Bk-Snapshot) 'Cancelling file choice leaves all business values unchanged'
  $page=Bk-Import 'damaged.json';Assert-That (-not $page.backupPreviewSummary -and $page.backupMessage) 'A damaged JSON file is rejected with readable feedback'
  Bk-Equal $before (Bk-Snapshot) 'A damaged file cannot write business values'
  $page=Bk-Import 'photo-incompatible.json';Assert-That (-not $page.backupPreviewSummary -and $page.backupMessage) 'A backup that loses the existing synthetic photo context is rejected'
  Bk-Equal $before (Bk-Snapshot) 'Photo compatibility rejection preserves photo metadata and every business value'
  $page=Bk-Import 'incoming-doing.json';Assert-That (-not $page.backupPreviewSummary -and $page.backupMessage) 'A backup containing unfinished execution cannot resurrect it through restoration'
  Bk-Equal $before (Bk-Snapshot) 'Rejecting unfinished execution in a file changes no business value'
  $page=Bk-Import
  Assert-That ($page.backupPreviewSummary.recordCount -eq 2 -and $page.backupPreviewSummary.restDayCount -eq 1 -and $page.backupPreviewSummary.planName -match '从文件恢复') 'The chosen real JSON file is validated and its counts and long plan name are previewed'
  Bk-Equal $before (Bk-Snapshot) 'A valid restoration preview writes no business value'
  Bk-Layout 'backup-preview' '.backup-preview' @('.backup-confirm','.backup-cancel-preview')
  Bk-Configure -Confirm $false;Tap '.backup-confirm';$null=Bk-Idle
  Bk-Equal $before (Bk-Snapshot) 'Cancelling the controlled final confirmation changes no business value'
  return $before
}
function Bk-RestoreAndUndo($Before){
  $page=Bk-Import;Bk-Configure -Confirm $true;Tap '.backup-confirm';$page=Bk-Idle;$after=Bk-Snapshot
  Assert-That ($after.values['dayflow.plans.v1'].version -eq 7 -and $after.values['dayflow.plans.v1'].name -match '从文件恢复') 'The confirmed file replaces the synthetic plan with the chosen backup version'
  Assert-That (@($after.values['dayflow.records.v2'].byDate.Keys).Count -eq 2 -and @($after.values['dayflow.restDays.v1'].byDate.Keys).Count -eq 1) 'Both history dates and the rest-day reason are restored'
  Assert-That (-not $after.values['dayflow.preferences.v1'].sleepReminderEnabled -and -not $after.values['dayflow.preferences.v1'].taskReminderEnabled -and @($after.values['dayflow.preferences.v1'].subscriptionTemplateIds).Count -eq 0) 'Restored reminders remain off and native subscription configuration is not imported'
  Assert-That ((ConvertTo-Json $Before.values['dayflow.media.v1'] -Depth 20 -Compress) -eq (ConvertTo-Json $after.values['dayflow.media.v1'] -Depth 20 -Compress)) 'The existing synthetic photo and its association are retained exactly'
  Assert-That ($page.backupUndoAvailable -and -not $page.backupRecoveryRequired) 'A verified original-content restore point is offered after successful restoration'
  $null=Bk-Discover;Bk-Layout 'backup-restored' '.local-backup-panel' @('.backup-undo')
  Bk-Configure -Confirm $false;Tap '.backup-undo';$null=Bk-Idle
  Bk-Equal $after (Bk-Snapshot) 'Cancelling undo retains the restored content and its restore point'
  Bk-Configure -Confirm $true;Tap '.backup-undo';$page=Bk-Idle
  Bk-Equal $Before (Bk-Snapshot) 'Undo restores original raw values and key existence including reminders and photo references'
  Assert-That (-not $page.backupRecoveryRequired) 'Undo completes without an outstanding recovery state'
}
function Bk-RejectionsAndRecovery {
  $null=Bk-Seed;$null=Bk-Import
  $changed=Bk-Evaluate 'mutatePlan' @($script:State.nonce);Assert-That $changed.changed 'A synthetic concurrent plan change is introduced after preview'
  $before=Bk-Snapshot;Bk-Configure -Confirm $true;Tap '.backup-confirm';$page=Bk-Idle
  Bk-Equal $before (Bk-Snapshot) 'A stale confirmation lease cannot overwrite the concurrently changed plan'
  Assert-That ([bool]$page.backupMessage) 'Stale preview rejection explains that another preview is needed'
  $null=Bk-Seed;$before=Bk-Snapshot;$null=Bk-Import;Bk-Configure -Confirm $true -Fault 'once';Tap '.backup-confirm';$page=Bk-Idle
  Assert-That ($page.backupMessage -and -not $page.backupRecoveryRequired) 'A single injected storage write failure reports failure after full rollback'
  Bk-Configure -Fault 'none';Bk-Equal $before (Bk-Snapshot) 'A failed confirmed restore rolls every raw key and restore-point manifest back exactly'
  $null=Bk-Import;Bk-Configure -Confirm $true -Fault 'incomplete';Tap '.backup-confirm';$page=Bk-Idle
  Assert-That ($page.backupRecoveryRequired) 'A synthetic forward failure plus rollback failure exposes recovery-required instead of claiming success'
  Bk-Configure -Fault 'none';$null=Bk-Discover
  Bk-Layout 'backup-recovery-required' '.local-backup-panel' @('.backup-undo')
  Bk-Configure -Confirm $true;Tap '.backup-undo';$page=Bk-Idle
  Assert-That (-not $page.backupRecoveryRequired) 'Retrying the visible original-content recovery succeeds after the synthetic fault is removed'
  Bk-Equal $before (Bk-Snapshot) 'Recovery restores original values and restore-point existence exactly'
  foreach($scenario in @('doing','paused')){
    $null=Bk-Seed $scenario;$before=Bk-Snapshot;$page=Bk-Import
    Assert-That (-not $page.backupPreviewSummary -and $page.backupMessage) ('Unsafe '+$scenario+' execution state prevents restoration')
    Bk-Equal $before (Bk-Snapshot) ('Rejecting '+$scenario+' state changes no business value')
    if($scenario -eq 'paused'){
      Assert-That $page.backupTimerBlocked 'Paused timer protection exposes a separate explicit finish-timer action'
      Bk-Configure -Confirm $false;Tap '.backup-clear-timer';$null=Bk-Idle
      Bk-Equal $before (Bk-Snapshot) 'Cancelling the separate finish-timer confirmation changes nothing'
      Bk-Configure -Confirm $true;Tap '.backup-clear-timer';$page=Bk-Idle;$cleared=Bk-Snapshot
      Assert-That (-not $cleared.values.ContainsKey('dayflow.timer.v1') -and -not $page.backupTimerBlocked) 'Explicit timer confirmation ends only the unfinished countdown'
      Bk-BusinessEqual $before $cleared 'Ending the timer never changes task execution facts, plan, rest or photo metadata'
      Assert-That ([bool]$page.backupPreviewSummary) 'The already selected file is rechecked after ending the timer without choosing it again'
      Assert-That ($cleared.values['dayflow.plans.v1'].version -eq $before.values['dayflow.plans.v1'].version) 'Ending the timer and rechecking the file never confirms a restore automatically'
      Tap '.backup-cancel-preview';$null=Bk-Idle
    }
  }
}
function Bk-RestartContext {
  if($script:Pending){throw 'Resolve the original pending task before context verification.'}
  if(-not $script:State.harnessInstalled){return}
  if(-not $script:State.sdkRefreshRequested){
    $script:State.sdkRefreshRequested=$true;Save-State
    $null=Invoke-Ide 'simulator_refresh' @() -ProjectTool
  }
  for($attempt=0;$attempt -lt 5;$attempt++){
    try{$context=Bk-Evaluate 'sdkContext'}catch{
      if($script:Pending){throw}
      if($_.Exception.Data['ToolErrorType'] -eq 'MCP_TOOL_ERROR' -and $_.Exception.Data['ToolMessage'] -eq 'timeout waiting for automator response'){continue}
      throw
    }
    if($context.appReady -and $context.pageReady -and $context.harnessAbsent -and $context.apisReady){
      $script:State.sdkContextRestartVerified=$true;$script:State.harnessInstalled=$false;Save-State
      Assert-That $true 'Controlled API hooks cleared by one SDK context refresh and bounded read-only readiness checks';return
    }
  }
  throw 'SDK context restart was not proven; verify the requested refresh without replaying it.'
}
function Bk-VerifyOriginal([string]$Reason='interrupted restore'){
  $expected=(& node (Join-Path $PSScriptRoot 'local-backup-acceptance-fixtures.js') '--comparison' (Join-Path $script:RunDirectory 'all-dayflow-backup.json')|Out-String)|ConvertFrom-Json -AsHashtable
  if($LASTEXITCODE -ne 0 -or -not $expected.text){throw 'The original snapshot cannot be compared safely.'}
  $current=Bk-Evaluate 'storageComparison'
  if($current.text -cne $expected.text){throw 'Current data differs after an interrupted restore; preserve it and request a read-only audit, never replay the old snapshot.'}
  Assert-That $true ('Read-only exact original-value comparison passed: '+$Reason)
  return $true
}
function Bk-RestoreStorage {
  if($script:Pending){throw 'Resolve the original pending task before storage verification.'}
  if($script:State.storageRestored){return}
  if($Mode -eq 'Restore' -and ($script:State.restoreFirstStarted -or $script:State.restoreUiStarted -or $script:State.restoreSecondStarted)){$null=Bk-VerifyOriginal 'resuming a started restoration'}
  if(-not $script:State.restoreFirstVerified){
    if($script:State.restoreFirstStarted){$null=Bk-VerifyOriginal 'first restore response was interrupted'}else{
      $script:State.restoreFirstStarted=$true;Save-State;Ux-RestoreAll
    }
    $script:State.restoreFirstVerified=$true;Save-State
  }
  if(-not $script:State.restoreUiVerified){
    if($script:State.restoreUiStarted){
      $ui=Bk-Evaluate 'originalInterfaceReady';if(-not $ui.ready){throw 'Original interface return was interrupted; inspect it without replaying navigation.'}
    }else{
      $script:State.restoreUiStarted=$true;Save-State
      $null=Invoke-Ide 'automation_navigate' @('--action','reLaunch','--url','/pages/today/index') -ProjectTool
      $null=Wait-UxPage 'pages/today/index' '.today-jump' 'selectedDate';Tap '.today-jump'
      $real=Ux-Page '.weekday' 'selectedDate'
      Assert-That ($real.selectedDate -eq (Get-Date).ToString('yyyy-MM-dd')) 'Original interface returns to the actual local today'
      $null=Invoke-Ide 'automation_viewport_action' @('--action','pageScrollTo','--scroll-top','0') -ProjectTool
    }
    $script:State.restoreUiVerified=$true;Save-State
  }
  if(-not $script:State.restoreSecondVerified){
    if($script:State.restoreSecondStarted){$null=Bk-VerifyOriginal 'second restore response was interrupted'}else{
      $script:State.restoreSecondStarted=$true;Save-State;Ux-RestoreAll
    }
    $script:State.restoreSecondVerified=$true;Save-State
  }
  $script:State.storageRestored=$true;$script:State.originalInterfaceRestored=$true;Save-State
}
function Bk-Recover {
  if($script:Pending){throw 'Resolve the original pending task before recovery.'}
  if(-not $script:State.storageRestored){Bk-RestartContext}
  $cleanupError=$null
  if($script:State.fileCleanupNeeded){
    $cleanupIssued=$false
    try{
      if($script:State.cleanupStarted -and -not $script:State.cleanupFailedKnown){
        $check=Bk-Evaluate 'cleanupAbsent' @(@{nonce=$script:State.nonce;files=@($script:State.fileManifest)})
        if(-not $check.absent){throw 'File cleanup response was interrupted; inspect remaining files without replaying cleanup.'}
      }else{
        $null=Bk-Discover
        $script:State.cleanupStarted=$true;$script:State.cleanupFailedKnown=$false;Save-State
        $cleanupIssued=$true
        $files=Bk-Evaluate 'cleanupFiles' @(@{nonce=$script:State.nonce;before=@($script:State.backupBeforeNames);files=@($script:State.fileManifest)})
        Assert-That $files.cleaned 'Only manifest-owned synthetic files are removed; pre-existing backup files are untouched'
      }
      $script:State.cleanupVerified=$true;$script:State.fileCleanupNeeded=$false;Save-State
    }catch{if($script:Pending){throw};if($cleanupIssued -or -not $script:State.cleanupStarted -or $script:State.cleanupFailedKnown){$script:State.cleanupFailedKnown=$true;Save-State};$cleanupError=$_}
  }
  if(-not $script:State.storageRestored){Bk-RestoreStorage}
  $script:State.restoreNeeded=[bool]$script:State.fileCleanupNeeded -or -not [bool]$script:State.storageRestored;Save-State
  if($cleanupError){throw $cleanupError}
}

Save-State;$exitCode=0
try{
  $status=Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
  if($null -eq $status -or $status.versionRelation -notin @('equal','agent_ahead') -or $status.loginExpired -ne $false){throw 'DevTools version/login gate failed.'}
  if($status.cliTokenRequired -or $status.tokenRequired){$script:Token=$env:DAYFLOW_WECHAT_CLI_TOKEN;if(-not $script:Token){throw 'CLI token required; credential files are not read.'}}
  if($Mode -eq 'Poll'){
    if(-not $script:Pending){throw 'This run has no pending task.'}
    $terminal=Find-Object (Invoke-Ide 'polling_task_result' @('--task-id',$script:State.pendingTask.taskId)) 'status'
    if($null -eq $terminal -or $terminal.status -notin @('success','failed','cancelled','expired')){throw 'Unknown task status; do not replay or recover.'}
    $script:Pending=$false;$script:State.pendingTask.status=$terminal.status;$script:State.outcome='paused-'+$terminal.status
    if($terminal.status -ne 'success'){$exitCode=1}
  }else{
    if($script:Pending){throw 'Resolve the original pending task before recovery.'}
    $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
    if($Mode -eq 'Restore'){Bk-Recover;$script:State.outcome='restored'}else{
      for($attempt=0;$attempt -lt 3;$attempt++){$original=Bk-Evaluate 'preflightOriginal';if($original.pageReady){break}}
      if(-not $original.pageReady){throw 'The original page is not ready for a read-only draft check; no synthetic write was made.'}
      if($original.draftDetected){throw 'The original page contains an unsaved editor or pending preview; finish or cancel it before testing. No draft was closed.'}
      if($original.busyDetected){throw 'The original page still has a pending user action; no synthetic write was made.'}
      if($original.recoveryBlocked){throw 'The original restore point is unfinished or unreadable; recover the user content normally before testing.'}
      Assert-That $original.ready 'Original user drafts and restore-point status pass a read-only preflight without exposing page data'
      $snapshot=Evaluate ($sources.backup -replace '\r?\n',' ') @($sources.keys)
      Save-Json $snapshot (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -PreserveValues
      $script:State.restoreNeeded=$true;Save-State
      $manifest=Wz-Manifest;Save-Json $manifest (Join-Path $script:RunDirectory 'source-manifest.json')
      foreach($page in @('profile','today','plans','training','stats')){foreach($suffix in @('wxml','wxss')){$null=Invoke-Ide ('compile_'+$suffix) @('--file-path',("pages/$page/index.$suffix")) -ProjectTool}}
      $files=Bk-Evaluate 'listBackupFiles';$script:State.backupBeforeNames=@($files.names);$script:State.fileCleanupNeeded=$true;Save-State
      $prepared=Bk-Evaluate 'setupFiles' @(@{nonce=$script:State.nonce;files=$backupSources.payload.files})
      Assert-That $prepared.prepared 'Synthetic JSON and image bytes are created and read back in a unique nonce-owned fixture directory'
      $script:State.harnessInstalled=$true;Save-State
      $installed=Bk-Evaluate 'installHarness' @(@{nonce=$script:State.nonce});Assert-That $installed.installed 'Controlled native callbacks are installed without opening a real share recipient'
      $before=Bk-ExportAndPreview
      Bk-RestoreAndUndo $before
      if($Mode -eq 'Validate'){Bk-RejectionsAndRecovery}
      Save-Json (Invoke-Ide 'get_simulator_console' @('--command','grep -n .') -ProjectTool) (Join-Path $script:RunDirectory 'console-all.local.json')
      Assert-That ((ConvertTo-Json $manifest -Compress) -eq (ConvertTo-Json (Wz-Manifest) -Compress)) 'Business source files stayed frozen throughout local-backup acceptance'
      $script:State.outcome='interaction-pass-visual-review-required';$script:State.simulatorInteractionVerified=$true
    }
  }
}catch{
  $exitCode=1;if(-not $script:Pending){$script:State.outcome='failed'}
  $message=$_.Exception.Message;if($script:Token){$message=$message.Replace($script:Token,'[REDACTED]')};$script:State.error=$message;Write-Warning $message
}finally{
  if($Mode -in @('Validate','Layout') -and $script:State.restoreNeeded -and -not $script:Pending){
    try{Bk-Recover}catch{$exitCode=1;$script:State.outcome='restoration-required';$script:State.restoreNeeded=$true;$script:State.error=$_.Exception.Message;Write-Warning 'Keep the original snapshot and synthetic-file manifest; complete this run recovery before another test.'}
  }
  $script:State.finished=(Get-Date).ToString('o');Save-State
  Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
