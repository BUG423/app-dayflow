#requires -Version 7.3
[CmdletBinding()]
param(
  [string]$Project = (Split-Path $PSScriptRoot -Parent),
  [string]$WechatIde = 'E:\Software\微信web开发者工具\wechatide.cmd',
  [ValidateSet('Environment','Validate','Restore','Poll')][string]$Mode = 'Validate',
  [string]$RunDirectory
)
if ($Mode -eq 'Validate') {
  # The current editor is a four-step wizard. Keep legacy recovery below intact.
  # Old Restore/Poll modes below still own their original multi-key backups.
  & (Join-Path $PSScriptRoot 'wechat-planning-wizard.ps1') -Project $Project -WechatIde $WechatIde -Mode Validate -RunDirectory $RunDirectory
  exit $LASTEXITCODE
}
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:Project = (Resolve-Path -LiteralPath $Project).Path
$script:Token = $env:DAYFLOW_WECHAT_CLI_TOKEN
$script:Pending = $false
$script:Sequence = 0
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'wechat-smoke.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Smoke helper syntax errors.' }
foreach ($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$artifactRoot = Join-Path $script:Project 'artifacts/wechat-iteration'
$activeFile = Join-Path $artifactRoot 'active-run.json'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
if (-not $RunDirectory) { $RunDirectory = Join-Path $artifactRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)) }
if ($Mode -in @('Restore','Poll')) {
  $script:RunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State = Get-Content -Raw -LiteralPath (Join-Path $RunDirectory 'state.json') | ConvertFrom-Json -AsHashtable
  if ($script:State.project -ne $script:Project) { throw 'Backup project mismatch.' }
  $script:Sequence = @(Get-ChildItem -LiteralPath $RunDirectory -Filter '*.log').Count
  $script:Pending = $null -ne $script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'
} else {
  if (Test-Path -LiteralPath $activeFile) {
    $old = Get-Content -Raw -LiteralPath $activeFile | ConvertFrom-Json -AsHashtable
    if ($old.pending -or $old.restoreNeeded) { throw "Previous run requires recovery: $($old.runDirectory)" }
  }
  if(Test-Path -LiteralPath (Join-Path $RunDirectory 'state.json')){throw 'Use a new run directory.'}
  New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
  $script:RunDirectory = (Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State = @{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';restoreNeeded=$false;assertions=@();pendingTask=$null;simulatorInteractionVerified=$false;realDeviceVerified=$false}
}
$sources = (& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js') | Out-String) | ConvertFrom-Json -AsHashtable
function Input-Element([string]$Selector,[string]$Value) { $null = Invoke-Ide 'automation_element_action' @('--selector',$Selector,'--action','input','--value',$Value,'--wait-for-selector',$Selector) -ProjectTool }
function Trigger-Element([string]$Selector,[string]$Type,$Detail) {
  $file = Join-Path $script:RunDirectory ('detail-' + [guid]::NewGuid().ToString('N') + '.json')
  Save-Json $Detail $file -PreserveValues
  $null = Invoke-Ide 'automation_element_action' @('--selector',$Selector,'--action','trigger','--type',$Type,'--detail-file',$file,'--wait-for-selector',$Selector) -ProjectTool
}
function Mock-Api([string]$Method,$Result) {
  $file = Join-Path $script:RunDirectory ('mock-' + [guid]::NewGuid().ToString('N') + '.json')
  Save-Json $Result $file
  $null = Invoke-Ide 'automation_wx_api' @('--action','mock','--method',$Method,'--result-file',$file) -ProjectTool
  if ($script:State.mocked -notcontains $Method) { $script:State.mocked += $Method; Save-State }
}
function Restore-Apis {
  foreach ($method in @($script:State.mocked)) { $null = Invoke-Ide 'automation_wx_api' @('--action','restore','--method',$method) -ProjectTool }
  $script:State.mocked = @(); Save-State
}
function Screenshot([string]$Name,[string]$Selector) {
  $null=Evaluate "function(selector){return new Promise(function(resolve){wx.pageScrollTo({selector:selector,duration:0,success:function(){resolve({dayflowSmoke:true,scrolled:true});},fail:function(){resolve({dayflowSmoke:true,scrolled:false});}});});}" @($Selector)
  $null=Invoke-Ide 'simulator_screenshot' @('--path',(Join-Path $script:RunDirectory ($Name+'.png')),'--optimize=false','--wait-for-selector',$Selector) -ProjectTool
}
function Restore-All {
  $snapshot = Get-Content -Raw -Encoding utf8 -LiteralPath (Join-Path $script:RunDirectory 'all-dayflow-backup.json') | ConvertFrom-Json -AsHashtable
  $result = Evaluate ($sources.restore -replace '\r?\n',' ') @($snapshot)
  Assert-That ($result.equal -eq $true) 'All Dayflow values and key existence restored and read back'
  $script:State.restoreNeeded=$false; Save-State
}
Save-State
$exitCode=0
try {
  if($Mode -eq 'Poll') {
    if(-not $script:Pending){throw 'No pending task.'}
    $result=Invoke-Ide 'polling_task_result' @('--task-id',$script:State.pendingTask.taskId)
    $terminal=Find-Object $result 'status'
    if($null -eq $terminal -or $terminal.status -notin @('success','failed','cancelled','expired')){throw 'Unknown task state; do not replay.'}
    $script:Pending=$false; $script:State.pendingTask.status=$terminal.status; $script:State.outcome='paused-'+$terminal.status
    if($terminal.status -ne 'success'){$exitCode=1}
  } else {
  if($script:Pending){throw 'Resolve the pending task with Poll before restoration.'}
  $status = Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
  if ($null -eq $status -or $status.versionRelation -notin @('equal','agent_ahead') -or $status.loginExpired -ne $false) { throw 'DevTools version/login gate failed.' }
  if (($status.cliTokenRequired -or $status.tokenRequired) -and -not $script:Token) { throw 'CLI token required; no credentials were read.' }
  if ($Mode -eq 'Environment') {
    $summary=@{cliReady=$true;cloudReadable=$false;cloudEnvironmentCount=$null;androidToolAvailable=$false;androidAuthorizedDevices=$null;androidUnauthorizedDevices=$null;iosCheck='not-confirmed';iosConnectedHardware=$null}
    try {
      $cloud=Invoke-Ide 'cloud_env_list' @() -ProjectTool
      Save-Json $cloud (Join-Path $script:RunDirectory 'cloud-environments.local.json') -PreserveValues
      $list=Find-Object $cloud 'envList'; if(-not $list){$list=Find-Object $cloud 'envs'}; if(-not $list){$list=Find-Object $cloud 'environments'}
      if ($list) { $key=@('envList','envs','environments') | Where-Object {$list.Contains($_)} | Select-Object -First 1; $summary.cloudEnvironmentCount=@($list[$key]).Count; $summary.cloudReadable=$true }
      elseif ($cloud -is [array]) { $summary.cloudEnvironmentCount=@($cloud).Count; $summary.cloudReadable=$true }
    } catch { $summary.cloudError=$_.Exception.Message }
    $adb=Get-ChildItem 'E:\Software\微信web开发者工具\resources\app.asar.unpacked\bin\adb-win' -Filter adb.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if($adb){ $summary.androidToolAvailable=$true; $devices=(& $adb.FullName devices 2>&1 | Out-String); $summary.androidAuthorizedDevices=@($devices -split '\r?\n' | Where-Object {$_ -match '\sdevice$'}).Count; $summary.androidUnauthorizedDevices=@($devices -split '\r?\n' | Where-Object {$_ -match '\sunauthorized$'}).Count }
    if(Get-Command Get-PnpDevice -ErrorAction SilentlyContinue){try{$apple=@(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {$_.FriendlyName -match 'iPhone|iPad|Apple Mobile Device'});$summary.iosConnectedHardware=$apple.Count;$summary.iosCheck=if($apple.Count){'hardware-detected-wechat-authorization-unverified'}else{'no-connected-hardware'}}catch{$summary.iosCheck='hardware-check-unavailable'}}
    Save-Json $summary (Join-Path $script:RunDirectory 'environment-summary.json'); $script:State.outcome='environment-checked'; Write-Output (ConvertTo-Json $summary -Compress)
  } elseif ($Mode -eq 'Restore') {
    if($script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'){throw 'Pending task must be resolved before restoration.'}
    $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
    Restore-Apis; Restore-All; $script:State.outcome='restored'
  } else {
    $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
    $snapshot=Evaluate ($sources.backup -replace '\r?\n',' ') @($sources.keys)
    Save-Json $snapshot (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -PreserveValues
    $script:State.restoreNeeded=$true; $script:State.mocked=@(); Save-State
    $null=Evaluate ($sources.seed -replace '\r?\n',' ')
    $config=Get-Content -Raw -Encoding utf8 (Join-Path $script:Project 'project.config.json')|ConvertFrom-Json
    $app=Get-Content -Raw -Encoding utf8 (Join-Path (Join-Path $script:Project $config.miniprogramRoot) 'app.json')|ConvertFrom-Json
    foreach($path in $app.pages){$null=Invoke-Ide 'compile_wxml' @('--file-path',"$path.wxml") -ProjectTool; $null=Invoke-Ide 'compile_wxss' @('--file-path',"$path.wxss") -ProjectTool}
    $null=Invoke-Ide 'simulator_open_page' @('--page','pages/today/index') -ProjectTool
    Wait-Page 'pages/today/index'; $todayPage=Get-Page '.weekday'; $today=$todayPage.selectedDate
    Assert-That ($todayPage.isToday -eq $true -and @($todayPage.week).Count -eq 7) 'Today and seven dates load'
    Screenshot 'today' '.weekday'
    $timeProbe=Evaluate ($sources.timeProbe -replace '\r?\n',' ')
    Assert-That ($timeProbe.before -and $timeProbe.start -and $timeProbe.end -and $timeProbe.midnight -and $timeProbe.preserve) 'Injected minute and midnight boundaries update actual page; Date restored in finally'
    $storageProbe=Evaluate ($sources.storageProbe -replace '\r?\n',' ')
    Assert-That ($storageProbe.errorShown -and $storageProbe.writes -eq 0) 'Injected storage read failure shows recovery UI without writing records; APIs restored'
    foreach($day in $todayPage.week){Tap ".weekday[data-date='$($day.date)']"; $p=Get-Page '.weekday'; Assert-That ($p.selectedDate -eq $day.date) "Select date $($day.date)"}
    Tap '.today-jump'
    Navigate 'switchTab' '/pages/plans/index'; Tap '.create-schedule'
    Input-Element "input[data-field='scheduleTitle']" '验收合成安排'
    Input-Element "input[data-field='title']" '验收长标题：在有限时间里按自己的节奏完成一项可以随时调整的练习安排'
    Tap '.add-action'; Input-Element "input[data-index='0'][data-field='title']" '验收练习项'
    Screenshot 'plan-editor' '#schedule-editor'
    Tap '.save-schedule'; $plans=Get-Page ''
    $created=@($plans.schedules | Where-Object {$_.title -eq '验收合成安排'})
    Assert-That ($created.Count -eq 1 -and $plans.templateVersion -gt 1 -and -not $plans.editorVisible) 'Native form creates a versioned schedule'
    Tap ".schedule-edit[data-id='$($created[0].id)']"; Input-Element "input[data-field='title']" '验收修改后的时间块'; Tap '.save-schedule'
    $plans=Get-Page ''; Assert-That (@($plans.schedules | Where-Object {$_.blockLabel -match '验收修改后的时间块'}).Count -eq 1) 'Native form edits the schedule'
    Mock-Api 'showModal' @{confirm=$true;cancel=$false}
    Tap ".schedule-delete[data-id='$($created[0].id)']"; $plans=Get-Page ''; Assert-That (@($plans.schedules|Where-Object {$_.id -eq $created[0].id}).Count -eq 0) 'Native delete button removes only the synthetic schedule'
    Navigate 'switchTab' '/pages/today/index'; Tap ".block-header[data-id='music']"
    Mock-Api 'showActionSheet' @{tapIndex=0;cancel=$false}; Tap ".task-menu[data-id='music-guitar']"
    $p=Get-Page '.task-menu'; Assert-That (@($p.blocks|ForEach-Object {$_.actions}|Where-Object {$_.id -eq 'music-guitar'})[0].status -eq 'doing') 'Status menu starts a task'
    Tap ".check-button[data-id='music-guitar']"; $p=Get-Page '.check-button'
    Assert-That ((Record-State $p 'music-guitar') -and -not (Record-State $p 'music-vocal')) 'Parallel completion stays independent'
    Mock-Api 'showActionSheet' @{tapIndex=2;cancel=$false}; Tap ".task-menu[data-id='music-vocal']"; $p=Get-Page '.task-menu'
    Assert-That (@($p.blocks|ForEach-Object {$_.actions}|Where-Object {$_.id -eq 'music-vocal'})[0].status -eq 'skipped') 'Status menu can skip without counting completion'
    Mock-Api 'showActionSheet' @{tapIndex=5;cancel=$false}; Tap ".task-menu[data-id='music-vocal']"; $p=Get-Page '.task-menu'
    Assert-That (@($p.blocks|ForEach-Object {$_.actions}|Where-Object {$_.id -eq 'music-vocal'})[0].status -eq 'todo') 'Status menu can restore todo'
    Mock-Api 'showActionSheet' @{tapIndex=3;cancel=$false}; Tap ".task-menu[data-id='music-vocal']"; Tap '.modal-card .button-primary'; $p=Get-Page '.task-menu'
    Assert-That (@($p.blocks|ForEach-Object {$_.actions}|Where-Object {$_.id -eq 'music-vocal'})[0].status -eq 'deferred') 'Defer editor records the selected future date'
    Navigate 'switchTab' '/pages/plans/index'; Tap ".deferred-schedule[data-id='music-vocal']"
    $deferred=Evaluate "function(date){var template=wx.getStorageSync('dayflow.plans.v1');var record=wx.getStorageSync('dayflow.records.v2');var count=0;template.schedules.forEach(function(s){s.blocks.forEach(function(b){b.tasks.forEach(function(t){if(t.origin && t.origin.date===date && t.origin.targetId==='music-vocal')count++;});});});return {dayflowSmoke:true,count:count,sourcePreserved:record.byDate[date]['music-vocal'].status==='deferred'};}" @($today)
    Assert-That ($deferred.count -eq 1 -and $deferred.sourcePreserved) 'Plan page schedules deferred target while preserving the source history'
    Navigate 'switchTab' '/pages/today/index'
    Tap ".block-header[data-id='training']"; Tap ".detail-link[data-id='training']"; Wait-Page 'pages/training/index'
    $training=Get-Page '.exercise'; $first=$training.actions[0].id; $second=$training.actions[-1].id
    Tap '.execution-controls .button-primary'; $training=Get-Page '.exercise'; Assert-That ($training.actions[0].status -eq 'doing') 'Training start records doing'
    Tap ".check[data-id='$first']"; Tap '.stop'; $training=Get-Page '.exercise'
    Assert-That ($training.actions[0].done -and @($training.actions|Where-Object {-not $_.done -and $_.status -ne 'aborted'}).Count -eq 0) 'Stop preserves completed actions and aborts remaining steps'
    Tap ".open-feedback[data-id='$first']"
    Input-Element '.feedback-editor textarea' '合成验收反馈，不包含个人健康资料'
    Tap '.feedback-editor .button-primary'; $training=Get-Page '.exercise'
    Assert-That ($training.actions[0].feedback.note -eq '合成验收反馈，不包含个人健康资料') 'Feedback is saved on the chosen action'
    $photoSource="function(){var path=wx.env.USER_DATA_PATH+'/dayflow-qa-synthetic.png';wx.getFileSystemManager().writeFileSync(path,'__PNG__','base64');return new Promise(function(resolve){wx.compressImage({src:path,quality:80,success:function(r){resolve({dayflowSmoke:true,path:path,temp:r.tempFilePath,compressed:true});},fail:function(e){resolve({dayflowSmoke:true,path:path,compressed:false,error:e.errMsg});}});});}"
    $image=Evaluate ($photoSource.Replace('__PNG__',$sources.png))
    Assert-That ($image.compressed -and $image.temp -and $image.temp -ne $image.path) 'Native compression creates a genuine temporary synthetic image'
    Mock-Api 'requirePrivacyAuthorize' @{errMsg='requirePrivacyAuthorize:ok'}
    Mock-Api 'chooseMedia' @{errMsg='chooseMedia:ok';tempFiles=@(@{tempFilePath=$image.temp;size=68;fileType='image'});type='image'}
    Tap ".choose-photo[data-id='$first']"; $training=Get-Page '.record-photo'
    $photos=@($training.actions[0].photos)
    Assert-That ($photos.Count -eq 1 -and $photos[0].localPath -ne $image.temp) 'Synthetic photo is persistently saved through the native file API without using the user album'
    Screenshot 'training-photo' '.record-photo'
    Tap ".remove-photo[data-photo-id='$($photos[0].id)']"; $training=Get-Page '.exercise'
    Assert-That (@($training.actions[0].photos).Count -eq 0) 'Photo association can be removed without changing completion'
    $cleanup=Evaluate "function(saved,source){return new Promise(function(resolve){var files=wx.getFileSystemManager();files.removeSavedFile({filePath:saved,success:function(){try{files.unlinkSync(source);}catch(e){}resolve({dayflowSmoke:true,cleaned:true});},fail:function(){try{files.unlinkSync(saved);files.unlinkSync(source);resolve({dayflowSmoke:true,cleaned:true});}catch(e){resolve({dayflowSmoke:true,cleaned:false});}}});});}" @($photos[0].localPath,$image.path)
    Assert-That ($cleanup.cleaned) 'Only the generated synthetic photo files are cleaned up'
    Tap ".select-timer[data-id='$second']"; Input-Element '.timer-panel input' '12'; Tap '.start-timer'; $training=Get-Page '.timer-panel'
    Assert-That ($training.timerState.status -eq 'running') 'Timer starts without completing the action'
    Tap '.timer-controls .button-secondary'; $training=Get-Page '.timer-panel'; Assert-That ($training.timerState.status -eq 'paused') 'Timer pauses'
    $remaining=$training.timerState.remainingSeconds; Tap '.close-timer'; Navigate 'navigateBack' '' 'pages/today/index'
    Tap ".detail-link[data-id='training']"; Wait-Page 'pages/training/index'; $training=Get-Page '.exercise'
    Assert-That ($training.timerState.status -eq 'paused' -and $training.timerState.remainingSeconds -eq $remaining) 'Timer survives page hide and recreation without losing paused time'
    Tap '.active-timer'; Tap '.timer-controls .button-secondary'; Start-Sleep -Seconds 13; $training=Get-Page '.timer-panel'
    Assert-That ($training.timerState.status -eq 'finished' -and @($training.actions|Where-Object {$_.id -eq $second})[0].status -eq 'aborted') 'Timer resumes and expires without completing a task'
    Tap '.timer-controls .button-secondary'; $training=Get-Page '.timer-panel'; Assert-That ($training.timerState.status -eq 'paused' -and $training.timerState.remainingSeconds -eq 12) 'Timer reset restores the chosen duration and stays paused'
    Screenshot 'training-timer' '.timer-panel'; Tap '.close-timer'
    Navigate 'navigateBack' '' 'pages/today/index'; $p=Get-Page '.weekday'; Assert-That (@($p.blocks|Where-Object {$_.id -eq 'training'})[0].doneCount -eq 1) 'Returning from training refreshes timeline'
    $beforeInvalid=Evaluate ($sources.inspect -replace '\r?\n',' ')
    Navigate 'navigateTo' '/pages/training/index?date=2026-02-30'; $invalid=Get-Page ''
    Assert-That ($invalid.dateKey -eq '' -and @($invalid.actions).Count -eq 0) 'Invalid training calendar date has no executable actions'
    Navigate 'navigateBack' '' 'pages/today/index'; $afterInvalid=Evaluate ($sources.inspect -replace '\r?\n',' ')
    Assert-That ($beforeInvalid.dates -eq $afterInvalid.dates) 'Invalid route did not add an execution date'
    $future=Local-DatePlus $today 7; Tap ".week-arrow[data-delta='1']"; Tap ".weekday[data-date='$future']"; Tap ".block-header[data-id='training']"; Tap ".detail-link[data-id='training']"; Wait-Page 'pages/training/index'
    Tap '.execution-controls .button-secondary'; $training=Get-Page '.exercise'; Assert-That ($training.emergencyEnabled -eq $true) 'Future unlocked date can choose the emergency plan'
    Tap '.execution-controls .button-secondary'; $training=Get-Page '.exercise'; Assert-That ($training.emergencyEnabled -eq $false) 'Emergency plan can be exited voluntarily'
    Navigate 'switchTab' '/pages/stats/index'; Tap '.history-apply'; $stats=Get-Page ''
    Assert-That ($stats.weeklyDone -ge 2 -and $stats.trainingCompleted -ge 1 -and @($stats.historyRecords).Count -ge 3) 'Statistics use real completed leaves and retained history'
    $recordKey=$stats.historyRecords[0].recordKey; Tap ".record-events-toggle[data-id='$recordKey']"; $stats=Get-Page ''
    Assert-That (@($stats.historyRecords|Where-Object {$_.recordKey -eq $recordKey})[0].expanded -eq $true) 'History status events can be expanded from the real interface'
    Tap ".history-details[data-date='$today']"; Screenshot 'history' '.history-apply'
    Navigate 'switchTab' '/pages/profile/index'; Trigger-Element '.sleep-reminder' 'change' @{value=$true}; $profile=Get-Page ''; Assert-That ($profile.preferences.sleepReminderEnabled -eq $true) 'Sleep reminder preference persists'
    Mock-Api 'showActionSheet' @{tapIndex=1;cancel=$false}; Tap '.phase-setting'; $profile=Get-Page ''; Assert-That ($profile.preferences.trainingPhase -eq '巩固') 'Phase changes only after user selection'
    Tap '.subscription-button'; $profile=Get-Page ''; Assert-That ($profile.feedbackText -match '尚未配置') 'Missing subscription template degrades honestly'
    Tap '.refresh-reminders'; $profile=Get-Page ''; Assert-That (-not $profile.reminderBusy -and @($profile.reminderJobs).Count -eq 0) 'Unconfigured background reminder list stays empty without claiming delivery'
    Assert-That ($profile.sync.configured -eq $false) 'Unconfigured cloud sync remains unavailable without data upload'
    Screenshot 'profile' '.sync-card'
    Navigate 'switchTab' '/pages/plans/index'; Tap '.plan-toolbar .button-secondary'
    Trigger-Element '.import-content' 'input' @{value='{invalid'}; Tap '.preview-import'; $plans=Get-Page ''
    Assert-That (-not $plans.importPreview.ok) 'Invalid JSON import is rejected before confirmation'
    $version=$plans.templateVersion
    $fixture=@{schemaVersion=1;id='acceptance-import';name='验收导入计划';version=1;updatedAt=0;schedules=@(@{id='acceptance-schedule';title='合成导入安排';weekdays=@(0,1,2,3,4,5,6);effectiveFrom=$today;exceptions=@();blocks=@(@{id='acceptance-block';title='合成固定占用';start='20:00';end='20:15';kind='fixed';category='验收';tasks=@()})})}
    Trigger-Element '.import-content' 'input' @{value=(ConvertTo-Json $fixture -Depth 15 -Compress)}; Tap '.preview-import'; $plans=Get-Page ''
    Assert-That ($plans.importPreview.ok -and $plans.templateVersion -eq $version) 'Valid import previews without changing the template'
    Tap '.confirm-import'; $plans=Get-Page ''; Assert-That ($plans.templateVersion -gt $version -and @($plans.schedules|Where-Object {$_.title -eq '合成导入安排'}).Count -eq 1) 'Confirmed import creates a new version'
    $historyBefore=Evaluate "function(date){return {dayflowSmoke:true,snapshot:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')[date])};}" @($today)
    $importedVersion=$plans.templateVersion; $oldVersion=@($plans.versions|Where-Object {-not $_.isCurrent})[-1].version
    Tap ".restore-version[data-version='$oldVersion']"; $plans=Get-Page ''
    Assert-That ($plans.templateVersion -gt $importedVersion) 'Restoring a previous plan creates a new version'
    $historyAfter=Evaluate "function(date){return {dayflowSmoke:true,snapshot:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')[date])};}" @($today)
    Assert-That ($historyBefore.snapshot -eq $historyAfter.snapshot) 'Template import and version restoration do not rewrite locked execution history'
    Screenshot 'plans' '.schedule-card'
    $console=Invoke-Ide 'get_simulator_console' @('--command','grep -i error') -ProjectTool
    Save-Json $console (Join-Path $script:RunDirectory 'console-errors.json')
    $script:State.outcome='interaction-pass-console-review-required'; $script:State.simulatorInteractionVerified=$true
  }
  }
} catch {
  $exitCode=1; if(-not $script:Pending){$script:State.outcome='failed'}
  $script:State.error=$_.Exception.Message; Write-Warning $_.Exception.Message
} finally {
  if($Mode -eq 'Validate' -and $script:State.restoreNeeded -and -not $script:Pending){
    $recoveryFailed=$false
    try { Restore-Apis } catch { $recoveryFailed=$true }
    try { Restore-All } catch { $recoveryFailed=$true }
    if(-not $recoveryFailed){
      try { Navigate 'switchTab' '/pages/today/index'; Tap '.today-jump'; $null=Invoke-Ide 'automation_viewport_action' @('--action','pageScrollTo','--scroll-top','0') -ProjectTool; $realPage=Get-Page '.weekday'; Assert-That ($realPage.selectedDate -eq (Get-Date).ToString('yyyy-MM-dd')) 'Interface returns to the real today using original storage'; Restore-All; $script:State.originalInterfaceRestored=$true }
      catch { $recoveryFailed=$true }
    }
    if($recoveryFailed){$script:State.restoreNeeded=$true;$exitCode=1;$script:State.outcome='restoration-required';Write-Warning 'Keep the backup and run Restore before any further testing.'}
  }
  $script:State.finished=(Get-Date).ToString('o'); Save-State
  Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
