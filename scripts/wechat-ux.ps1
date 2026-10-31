#requires -Version 7.3
[CmdletBinding()]
param(
  [string]$Project=(Split-Path $PSScriptRoot -Parent),
  [string]$WechatIde='E:\Software\微信web开发者工具\wechatide.cmd',
  [ValidateSet('Validate','Layout','Gesture','Restore','Poll')][string]$Mode='Validate',
  [ValidateSet('default','narrow')][string]$Label='default',
  [switch]$DesktopGestures,
  [string]$RunDirectory
)
function Initialize-UxEncoding {
  # PowerShell uses Console.OutputEncoding when decoding native stdout. The
  # installed Windows host can start in CP936 while Node emits UTF-8 JSON.
  $script:OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
}
Initialize-UxEncoding
$ErrorActionPreference='Stop';$PSNativeCommandUseErrorActionPreference=$false
$script:Project=(Resolve-Path -LiteralPath $Project).Path;$script:Token=$env:DAYFLOW_WECHAT_CLI_TOKEN;$script:Pending=$false;$script:Sequence=0
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'wechat-smoke.ps1'),[ref]$null,[ref]$errors)
if($errors.Count){throw 'CLI helper syntax error.'}
foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
$artifactRoot=Join-Path $script:Project 'artifacts/wechat-ux';$activeFile=Join-Path $artifactRoot 'active-run.json'
New-Item -ItemType Directory -Path $artifactRoot -Force|Out-Null
if($Mode -in @('Restore','Poll')){
  if(-not $RunDirectory){throw 'Recovery requires the original RunDirectory.'}
  $script:RunDirectory=(Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State=Get-Content -LiteralPath (Join-Path $script:RunDirectory 'state.json') -Raw -Encoding utf8|ConvertFrom-Json -AsHashtable
  if($script:State.project -ne $script:Project){throw 'Backup project mismatch.'}
  $script:Sequence=@(Get-ChildItem -LiteralPath $script:RunDirectory -Filter '*.log').Count
  $script:Pending=$null -ne $script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'
}else{
  foreach($kind in @('wechat-iteration','wechat-visual','wechat-ux')){
    $marker=Join-Path $script:Project "artifacts/$kind/active-run.json"
    if(Test-Path -LiteralPath $marker){$previous=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json;if($previous.pending -or $previous.restoreNeeded){throw "Recover the previous $kind run before another validation."}}
  }
  if(-not $RunDirectory){$RunDirectory=Join-Path $artifactRoot ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$Label+'-'+$Mode.ToLowerInvariant())}
  if(Test-Path -LiteralPath (Join-Path $RunDirectory 'state.json')){throw 'Use a new run directory.'}
  New-Item -ItemType Directory -Path $RunDirectory -Force|Out-Null;$script:RunDirectory=(Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State=@{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';label=$Label;mode=$Mode;restoreNeeded=$false;assertions=@();pendingTask=$null;realDeviceVerified=$false;mocked=@()}
}
$sources=(& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js')|Out-String)|ConvertFrom-Json -AsHashtable
$uxSources=(& node (Join-Path $PSScriptRoot 'ux-acceptance-fixtures.js') (Get-Date).ToString('yyyy-MM-dd')|Out-String)|ConvertFrom-Json -AsHashtable
function Ux-Page([string]$Selector,[string]$Key){
  $arguments=@('--action','getData');if($Selector){$arguments+=@('--wait-for-selector',$Selector)}
  $reply=Invoke-Ide 'automation_page_action' $arguments -ProjectTool
  $page=Find-Object $reply $Key;if($null -eq $page){throw "Page data has no expected $Key."};return $page
}
function Wait-UxPage([string]$Path,[string]$Selector,[string]$Key){
  $stableId=$null
  for($attempt=0;$attempt -lt 5;$attempt++){
    try{
      $before=Find-Object (Invoke-Ide 'automation_runtime_info' @('--action','currentPage') -ProjectTool) 'currentPage'
      if($null -eq $before.currentPage -or $before.currentPage.path.TrimStart('/') -ne $Path){$stableId=$null;continue}
      if($null -eq $before.currentPage.pageId){throw 'Visible page has no pageId.'}
      $page=Ux-Page $Selector $Key
      $after=Find-Object (Invoke-Ide 'automation_runtime_info' @('--action','currentPage') -ProjectTool) 'currentPage'
      if($null -eq $after.currentPage -or $after.currentPage.pageId -ne $before.currentPage.pageId){$stableId=$null;continue}
      if($stableId -eq $after.currentPage.pageId){return $page};$stableId=$after.currentPage.pageId
    }catch{
      $kind=$_.Exception.Data['ToolErrorType'];$message=$_.Exception.Data['ToolMessage']
      if($kind -eq 'MCP_TOOL_ERROR' -and ($message -eq 'timeout waiting for automator response' -or $message -eq "waitForSelector timeout: ${Selector}: page is not on top of page stack")){$stableId=$null;continue}
      throw
    }
  }
  throw "Visible page $Path did not stabilize after bounded read-only observations; no click was replayed."
}
function Ux-Go([string]$Path,[string]$Selector,[string]$Key){
  $null=Invoke-Ide 'automation_navigate' @('--action','switchTab','--url',('/'+$Path)) -ProjectTool
  return Wait-UxPage $Path $Selector $Key
}
function Ux-Input([string]$Selector,[string]$Value){$null=Invoke-Ide 'automation_element_action' @('--selector',$Selector,'--action','input','--value',$Value,'--wait-for-selector',$Selector) -ProjectTool}
function Ux-Expand([string]$Flag,[string]$Toggle,[string]$Anchor){
  $state=Ux-Page $Anchor $Flag
  if($state[$Flag] -isnot [bool]){throw 'Cannot expand a panel with an unrecognised visibility state.'}
  if(-not $state[$Flag]){Tap $Toggle}
}
function Ux-Trigger([string]$Selector,[string]$Type,$Detail){
  $file=Join-Path $script:RunDirectory ('detail-'+[guid]::NewGuid().ToString('N')+'.json');Save-Json $Detail $file -PreserveValues
  $null=Invoke-Ide 'automation_element_action' @('--selector',$Selector,'--action','trigger','--type',$Type,'--detail-file',$file,'--wait-for-selector',$Selector) -ProjectTool
}
function Ux-DesktopGesture([string]$Name,[int]$Days){
  $before=Ux-Page '.weekday' 'selectedDate'
  $ack=Join-Path $script:RunDirectory ('gesture-'+$Name+'-ack.json')
  if(Test-Path -LiteralPath $ack){throw 'A fresh gesture acknowledgement path is required.'}
  Save-Json @{name=$Name;selector='.calendar';selectedBefore=$before.selectedDate;expectedDate=(Local-DatePlus $before.selectedDate $Days);acknowledgementFile=$ack;deadlineSeconds=180} (Join-Path $script:RunDirectory 'gesture-request.json')
  $script:State.gestureRequested=$Name;Save-State
  $deadline=[DateTime]::UtcNow.AddSeconds(180)
  while(-not (Test-Path -LiteralPath $ack)){
    if([DateTime]::UtcNow -gt $deadline){throw 'Desktop gesture timed out; no touch or click was replayed.'}
    Start-Sleep -Milliseconds 250
  }
  $acknowledgement=Get-Content -LiteralPath $ack -Raw -Encoding utf8|ConvertFrom-Json
  if($acknowledgement.name -ne $Name -or $acknowledgement.performed -ne $true){throw 'Gesture acknowledgement does not match this requested native drag.'}
  $after=Ux-Page '.weekday' 'selectedDate'
  if($script:State.touchProbeInstalled){$probe=Evaluate ($uxSources.readTouchProbe -replace '\r?\n',' ');Save-Json $probe (Join-Path $script:RunDirectory ('gesture-'+$Name+'-events.local.json'))}
  Assert-That ($after.selectedDate -eq (Local-DatePlus $before.selectedDate $Days)) ("Actual desktop calendar drag verified: "+$Name)
  $script:State.gestureRequested=$null;Save-State
}
function Ux-Shot([string]$Name,[string]$Selector){
  $null=Evaluate "function(selector){return new Promise(function(resolve){wx.pageScrollTo({selector:selector,duration:0,complete:function(){resolve({dayflowSmoke:true});}});});}" @($Selector)
  $null=Invoke-Ide 'simulator_screenshot' @('--path',(Join-Path $script:RunDirectory ($Label+'-'+$Name+'.png')),'--optimize=false','--wait-for-selector',$Selector) -ProjectTool
}
function Ux-Measure([string]$Name,[string[]]$Selectors){
  $result=Evaluate "function(selectors){var info=typeof wx.getWindowInfo==='function'?wx.getWindowInfo():wx.getSystemInfoSync();return new Promise(function(resolve){var q=wx.createSelectorQuery();selectors.forEach(function(s){q.selectAll(s).boundingClientRect();});q.exec(function(rects){resolve({dayflowSmoke:true,width:info.windowWidth,height:info.windowHeight,rects:rects});});});}" -Arguments (,$Selectors)
  Save-Json $result (Join-Path $script:RunDirectory ($Name+'-measurements.local.json'))
  Assert-That (($Label -ne 'narrow' -or $result.width -eq 320) -and ($Label -ne 'default' -or $result.width -eq 390)) 'Actual simulator width matches the selected acceptance label'
  for($i=0;$i -lt $Selectors.Count;$i++){
    $items=@($result.rects[$i]);Assert-That ($items.Count -gt 0) ("Visible measurement exists: "+$Selectors[$i])
    foreach($rect in $items){Assert-That ($rect.left -ge -1 -and $rect.right -le ($result.width+1)) ("No horizontal overflow: "+$Selectors[$i])}
  }
  return $result
}
function Ux-RestoreAll{
  $snapshot=Get-Content -LiteralPath (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -Raw -Encoding utf8|ConvertFrom-Json -AsHashtable
  $result=Evaluate ($sources.restore -replace '\r?\n',' ') @($snapshot)
  Assert-That ($result.equal -eq $true) 'All original Dayflow keys and values restored with exact read-back'
}
function Ux-RestoreInterface{
  Ux-RestoreAll
  # Closing all pages removes synthetic form drafts/previews held in tab caches.
  # This is navigation, not simulator/app restart; original storage stays authoritative.
  $null=Invoke-Ide 'automation_navigate' @('--action','reLaunch','--url','/pages/today/index') -ProjectTool
  $null=Wait-UxPage 'pages/today/index' '.today-jump' 'selectedDate';Tap '.today-jump'
  $real=Ux-Page '.weekday' 'selectedDate'
  Assert-That ($real.selectedDate -eq (Get-Date).ToString('yyyy-MM-dd')) 'Original interface returns to the actual local today'
  $null=Invoke-Ide 'automation_viewport_action' @('--action','pageScrollTo','--scroll-top','0') -ProjectTool
  Ux-RestoreAll;$script:State.restoreNeeded=$false;$script:State.originalInterfaceRestored=$true
}
function Ux-RestoreProbe{
  if($script:State.touchProbeInstalled){
    $restored=Evaluate ($uxSources.restoreTouchProbe -replace '\r?\n',' ')
    Save-Json $restored (Join-Path $script:RunDirectory 'touch-probe-restored.local.json')
    Assert-That ($restored.restored) 'Temporary touch handlers and gesture state are restored exactly'
    $script:State.touchProbeInstalled=$false;Save-State
  }
}
function Ux-LockedDate{
  $today=(Get-Date).ToString('yyyy-MM-dd');$future=Local-DatePlus $today 1
  $null=Ux-Go 'pages/plans/index' '.create-schedule' 'schedules';Tap '.create-schedule'
  $plans=Ux-Page '#schedule-editor' 'effectiveFrom'
  Assert-That ($plans.effectiveFrom -eq $future) 'When today is locked, new ordinary arrangements start on an explicit future date'
  Ux-Input '.schedule-name' '验收锁定日期新增'
  Ux-Trigger "picker[data-field='start']" 'change' @{value='06:00'};Ux-Trigger "picker[data-field='end']" 'change' @{value='06:30'}
  Ux-Trigger "picker[data-field='effectiveFrom']" 'change' @{value=$today}
  $before=Evaluate "function(date){return {dayflowSmoke:true,plan:JSON.stringify(wx.getStorageSync('dayflow.plans.v1')),versions:JSON.stringify(wx.getStorageSync('dayflow.planVersions.v1')),record:JSON.stringify(wx.getStorageSync('dayflow.records.v2')),snapshot:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')[date])};}" @($today)
  Tap '.save-schedule';$plans=Ux-Page '#schedule-editor' 'editorVisible'
  Assert-That ($plans.editorVisible -and $plans.title -eq '验收锁定日期新增' -and $plans.errorMessage) 'Saving into the locked single day is rejected clearly while preserving the draft'
  $after=Evaluate "function(date){return {dayflowSmoke:true,plan:JSON.stringify(wx.getStorageSync('dayflow.plans.v1')),versions:JSON.stringify(wx.getStorageSync('dayflow.planVersions.v1')),record:JSON.stringify(wx.getStorageSync('dayflow.records.v2')),snapshot:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')[date])};}" @($today)
  Assert-That ($before.plan -eq $after.plan -and $before.versions -eq $after.versions -and $before.record -eq $after.record -and $before.snapshot -eq $after.snapshot) 'Rejected single-day save does not alter the template, versions, records or locked snapshot'
  Ux-Trigger "picker[data-field='effectiveFrom']" 'change' @{value=$future};Tap '.save-schedule'
  $plans=Ux-Page '.create-schedule' 'editorVisible';Assert-That (-not $plans.editorVisible) 'Changing the preserved draft to an unexecuted future date saves successfully'
  $saved=Evaluate "function(){var t=wx.getStorageSync('dayflow.plans.v1');return {dayflowSmoke:true,matches:t.schedules.filter(function(s){return s.blocks.some(function(b){return b.title==='验收锁定日期新增';});})};}"
  Assert-That (@($saved.matches).Count -eq 1 -and $saved.matches[0].effectiveFrom -eq $future -and $saved.matches[0].effectiveTo -eq $future -and @($saved.matches[0].blocks[0].tasks).Count -eq 1) 'The corrected single-day rule belongs only to the chosen future date'
  $p=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate';Tap '.today-jump';$p=Ux-Page '.weekday' 'selectedDate'
  if(@($p.week|Where-Object {$_.date -eq $future}).Count){
    Tap ".weekday[data-date='$future']";$p=Ux-Page '.weekday' 'selectedDate'
    $visible=@($p.blocks|Where-Object {$_.title -eq '验收锁定日期新增'})
    Assert-That ($p.selectedDate -eq $future -and $visible.Count -eq 1 -and @($visible[0].actions).Count -eq 1) 'Actual future date selection displays the new ordinary arrangement'
    Ux-Shot 'future-arrangement' '.block-header'
  }else{
    # Do not pretend a method call is an actual swipe when tomorrow crosses weeks.
    $script:State.futureDateOutsideVisibleWeek=$true;Save-State
  }
  Tap '.today-jump'
}
function Ux-Layout{
  $null=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate';Tap '.today-jump'
  $stats=Ux-Go 'pages/stats/index' '.week-label' 'weekLabel'
  $boxes=Ux-Measure 'stats' @('.week-label','.week-controls','.previous-week','.current-week','.next-week','.history-date','.history-record','.record-title')
  foreach($index in @(2,3,4)){foreach($rect in @($boxes.rects[$index])){Assert-That ($rect.width -ge 44 -and $rect.height -ge 44) 'Statistics navigation keeps at least a 44px target'}}
  Assert-That (@($stats.historyRecords).Count -gt 0) 'Long synthetic execution records are visible in statistics'
  Ux-Shot 'stats-top' '.week-navigation';Ux-Shot 'stats-history' '.history-record'
  Tap '.record-events-toggle';$stats=Ux-Page '.record-events' 'historyRecords';Assert-That (@($stats.historyRecords|Where-Object {$_.expanded}).Count -ge 1) 'Long history status events can still expand'
  Ux-Shot 'stats-events' '.record-events'
  $profile=Ux-Go 'pages/profile/index' '.profile-section' 'expandedSection'
  if($profile.expandedSection){Tap ".profile-section[data-section='$($profile.expandedSection)']"}
  $profile=Ux-Page '.profile-section' 'expandedSection';Assert-That ($profile.expandedSection -eq '') 'Settings can return to concise collapsed entries'
  Ux-Shot 'profile' '.profile-section'
  Tap ".profile-section[data-section='reminders']";Ux-Trigger '.sleep-reminder' 'change' @{value=$true};$profile=Ux-Page '.sleep-reminder' 'preferences'
  Assert-That ($profile.preferences.sleepReminderEnabled) 'Reminder preferences remain editable behind their concise settings entry'
  Tap ".profile-section[data-section='data']";$profile=Ux-Page '.sync-card' 'sync'
  Assert-That (-not $profile.sync.configured -and -not $profile.sync.enabled) 'Unavailable cloud stays disabled without hidden automatic activation'
  Tap ".profile-section[data-section='training']";Ux-Expand 'phaseRulesVisible' '.phase-rules-toggle' '.phase-setting'
  $profile=Ux-Page '.phase-rule' 'phaseRuleDrafts'
  Assert-That (@($profile.phaseRuleDrafts).Count -gt 0) 'Training rules remain reachable behind their explicit entry'
  $null=Ux-Measure 'profile-training' @('.phase-rule','.save-phase-rules');Ux-Shot 'profile-training' '.phase-rule'
  if($Mode -eq 'Layout'){Ux-LockedDate}
  $null=Ux-Go 'pages/plans/index' '.create-schedule' 'schedules';Tap '.create-schedule';$plans=Ux-Page '#schedule-editor' 'editorVisible'
  Assert-That ($plans.editorVisible -and -not $plans.advancedVisible) 'Adding an ordinary arrangement starts with the simple form'
  $null=Ux-Measure 'plan-editor' @('#schedule-editor','.schedule-name','.save-schedule');Ux-Shot 'plan-editor' '#schedule-editor';Tap '.close-editor'
  $null=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate'
  $null=Ux-Measure 'today' @('.calendar','.weekday','.today-jump');Ux-Shot 'today' '.calendar'
}
Save-State;$exitCode=0
try{
  if($Mode -eq 'Poll'){
    if(-not $script:Pending){throw 'This run has no pending task.'}
    $terminal=Find-Object (Invoke-Ide 'polling_task_result' @('--task-id',$script:State.pendingTask.taskId)) 'status'
    if($null -eq $terminal -or $terminal.status -notin @('success','failed','cancelled','expired')){throw 'Unknown task state; do not replay or restore.'}
    $script:Pending=$false;$script:State.pendingTask.status=$terminal.status;$script:State.outcome='paused-'+$terminal.status
    if($terminal.status -ne 'success'){$exitCode=1}
  }else{
    if($script:Pending){throw 'Resolve the original pending task before restoring.'}
    $status=Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
    if($null -eq $status -or $status.versionRelation -notin @('equal','agent_ahead') -or $status.loginExpired -ne $false){throw 'DevTools version/login gate failed.'}
    if(($status.cliTokenRequired -or $status.tokenRequired) -and -not $script:Token){throw 'CLI token required; no credentials were read.'}
    if($Mode -eq 'Restore'){
      $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
      Ux-RestoreProbe
      Ux-RestoreInterface;$script:State.outcome='restored'
    }else{
      $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
      $snapshot=Evaluate ($sources.backup -replace '\r?\n',' ') @($sources.keys)
      Save-Json $snapshot (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -PreserveValues
      $script:State.restoreNeeded=$true;Save-State
      $manifest=@(Get-ChildItem (Join-Path $script:Project 'miniprogram') -Recurse -File|Sort-Object FullName|ForEach-Object {@{path=[IO.Path]::GetRelativePath($script:Project,$_.FullName);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
      Save-Json $manifest (Join-Path $script:RunDirectory 'source-manifest.json')
      if($Mode -eq 'Validate'){
        foreach($page in @('today','plans','stats','profile','training')){foreach($suffix in @('wxml','wxss')){$null=Invoke-Ide ('compile_'+$suffix) @('--file-path',("pages/$page/index.$suffix")) -ProjectTool}}
      }
      $null=Evaluate ($sources.seed -replace '\r?\n',' ')
      $today=(Get-Date).ToString('yyyy-MM-dd');$p=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate';Tap '.today-jump';$p=Ux-Page '.weekday' 'selectedDate'
      if($Mode -eq 'Gesture'){
        if(-not $DesktopGestures){throw 'Gesture diagnostics require the actual desktop gesture proxy.'}
        $probe=Evaluate ($uxSources.installTouchProbe -replace '\r?\n',' ');Assert-That ($probe.installed) 'Read-only touch instrumentation is installed without changing the event inputs or clock'
        $script:State.touchProbeInstalled=$true;Save-State
        Ux-DesktopGesture 'left' 7;Ux-DesktopGesture 'right' -7;Ux-DesktopGesture 'vertical' 0
        Ux-RestoreProbe;$script:State.nativeDesktopGesturesVerified=$true
      }
      if($Mode -eq 'Validate'){
        Assert-That ($p.selectedDate -eq $today -and @($p.week).Count -eq 7) 'Seven dates open with the actual local today selected'
        if((Get-Date).DayOfWeek -ne [DayOfWeek]::Sunday){$overtime=@($p.blocks|Where-Object {$_.title -eq '加班'});Assert-That ($overtime.Count -eq 1 -and $overtime[0].kind -eq 'fixed' -and @($overtime[0].actions).Count -eq 0) 'Ordinary overtime is explicit fixed occupation with no checkable task'}
        if($DesktopGestures){Ux-DesktopGesture 'left' 7;Ux-DesktopGesture 'right' -7;Ux-DesktopGesture 'vertical' 0;$script:State.nativeDesktopGesturesVerified=$true}
        else{$script:State.nativeDesktopGesturesVerified=$false}
        $p=Ux-Page '.weekday' 'selectedDate'
        $other=@($p.week|Where-Object {$_.date -ne $today})[0].date;Tap ".weekday[data-date='$other']";$p=Ux-Page '.weekday' 'selectedDate'
        Assert-That ($p.selectedDate -eq $other) 'Date cells remain directly selectable';Tap '.today-jump'
        $plans=Ux-Go 'pages/plans/index' '.create-schedule' 'schedules';Tap '.create-schedule'
        Ux-Input '.schedule-name' '验收加班';Ux-Trigger "picker[data-field='start']" 'change' @{value='06:00'};Ux-Trigger "picker[data-field='end']" 'change' @{value='06:30'}
        Ux-Trigger '.schedule-checkable' 'change' @{value=$false};Tap '.save-schedule'
        $plans=Ux-Page '.create-schedule' 'schedules';Assert-That (-not $plans.editorVisible) 'Simple fixed arrangement saves without advanced rule fields'
        $fixed=Evaluate "function(){var t=wx.getStorageSync('dayflow.plans.v1');var all=[];t.schedules.forEach(function(s){s.blocks.forEach(function(b){if(b.title==='验收加班')all.push({schedule:s,block:b});});});return {dayflowSmoke:true,matches:all};}"
        Assert-That (@($fixed.matches).Count -eq 1 -and $fixed.matches[0].block.kind -eq 'fixed' -and @($fixed.matches[0].block.tasks).Count -eq 0) 'Simple fixed input produces the ordinary fixed data model'
        $fixedId=$fixed.matches[0].schedule.id;Tap ".schedule-edit[data-id='$fixedId']";Ux-Input '.schedule-name' '验收加班已改名';Tap '.save-schedule'
        $plans=Ux-Page '.create-schedule' 'schedules'
        Assert-That (@($plans.schedules|Where-Object {$_.id -eq $fixedId -and $_.title -eq '验收加班已改名'}).Count -eq 1) 'Renaming a saved ordinary arrangement updates its visible list title'
        $renamed=Evaluate "function(id){var t=wx.getStorageSync('dayflow.plans.v1');return {dayflowSmoke:true,schedule:t.schedules.filter(function(s){return s.id===id;})[0]};}" @($fixedId)
        Assert-That ($renamed.schedule.blocks[0].id -eq $fixed.matches[0].block.id -and $renamed.schedule.blocks[0].title -eq '验收加班已改名' -and @($renamed.schedule.blocks[0].tasks).Count -eq 0) 'Renaming preserves the same ordinary fixed block without inventing a task'
        Tap '.create-schedule';Ux-Input '.schedule-name' '验收合成的较长中文行动名称：整理本周执行记录并检查下一周的工作安排'
        Ux-Trigger "picker[data-field='start']" 'change' @{value='06:35'};Ux-Trigger "picker[data-field='end']" 'change' @{value='06:45'};Tap '.save-schedule'
        $plans=Ux-Page '.create-schedule' 'schedules';Assert-That (-not $plans.editorVisible) 'Simple checkable arrangement inherits its name and saves without action rows'
        $createdTask=Evaluate "function(){var t=wx.getStorageSync('dayflow.plans.v1');var s=t.schedules.filter(function(s){return s.blocks.some(function(b){return b.title.indexOf('验收合成的较长')===0;});})[0];return {dayflowSmoke:true,schedule:s};}"
        Tap ".schedule-edit[data-id='$($createdTask.schedule.id)']";Ux-Input '.schedule-name' '验收合成的较长中文行动名称：修改名称后检查任务标识与列表是否同步';Tap '.save-schedule'
        $renamedTask=Evaluate "function(id){var t=wx.getStorageSync('dayflow.plans.v1');return {dayflowSmoke:true,schedule:t.schedules.filter(function(s){return s.id===id;})[0]};}" @($createdTask.schedule.id)
        Assert-That ($renamedTask.schedule.title -eq $renamedTask.schedule.blocks[0].title -and $renamedTask.schedule.blocks[0].tasks[0].title -eq $renamedTask.schedule.title -and $renamedTask.schedule.blocks[0].tasks[0].id -eq $createdTask.schedule.blocks[0].tasks[0].id) 'Renaming an ordinary checkable arrangement synchronizes titles while preserving its task ID'
        $beforeComplex=Evaluate "function(){var t=wx.getStorageSync('dayflow.plans.v1');var s=t.schedules.filter(function(s){return s.blocks.length>1;})[0];return {dayflowSmoke:true,schedule:s,plan:JSON.stringify(t)};}"
        Assert-That ($null -ne $beforeComplex.schedule) 'Representative existing multi-block schedule is available for editing'
        Tap ".schedule-edit[data-id='$($beforeComplex.schedule.id)']";$plans=Ux-Page '#schedule-editor' 'editorVisible'
        Assert-That ($plans.advancedVisible) 'Existing multi-block schedule opens its advanced settings explicitly'
        Tap '.advanced-toggle';Tap '.advanced-toggle';Tap '.save-schedule'
        $afterComplex=Evaluate "function(id){var t=wx.getStorageSync('dayflow.plans.v1');return {dayflowSmoke:true,schedule:t.schedules.filter(function(s){return s.id===id;})[0]};}" @($beforeComplex.schedule.id)
        Assert-That ((ConvertTo-Json $beforeComplex.schedule.blocks -Depth 60 -Compress) -eq (ConvertTo-Json $afterComplex.schedule.blocks -Depth 60 -Compress) -and (ConvertTo-Json $beforeComplex.schedule.exceptions -Depth 60 -Compress) -eq (ConvertTo-Json $afterComplex.schedule.exceptions -Depth 60 -Compress)) 'Folding advanced settings and saving preserves every existing block and exception'
        Ux-Expand 'toolsVisible' '.plan-tools-toggle' '.create-schedule'
        $beforePreview=Evaluate "function(){return {dayflowSmoke:true,plan:JSON.stringify(wx.getStorageSync('dayflow.plans.v1'))};}"
        Tap '.example-toggle';$plans=Ux-Page '.confirm-import' 'examplePreview'
        $afterPreview=Evaluate "function(){return {dayflowSmoke:true,plan:JSON.stringify(wx.getStorageSync('dayflow.plans.v1'))};}"
        Assert-That ($plans.examplePreview -and @($plans.exampleRows).Count -eq 7 -and $beforePreview.plan -eq $afterPreview.plan) 'New ordinary example can be previewed without overwriting the saved template'
        $p=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate'
        $block=@($p.blocks|Where-Object {$_.title -like '验收合成的较长*'})[0];Assert-That ($null -ne $block -and @($block.actions).Count -eq 1) 'The newly added ordinary task appears on the Today timeline'
        Tap ".block-header[data-id='$($block.id)']";Tap ".check-button[data-id='$($block.actions[0].id)']"
        $p=Ux-Page '.check-button' 'selectedDate';Assert-That (@($p.blocks|ForEach-Object {$_.actions}|Where-Object {$_.id -eq $block.actions[0].id})[0].done) 'The simple form task can be checked independently'
        $stats=Ux-Go 'pages/stats/index' '.week-label' 'weekLabel';$anchor=$stats.weekLabel
        Tap '.previous-week';$stats=Ux-Page '.week-label' 'weekLabel';Assert-That ($stats.weekLabel -ne $anchor) 'Statistics previous week remains usable without label squeezing'
        Tap '.next-week';$stats=Ux-Page '.week-label' 'weekLabel';Assert-That ($stats.weekLabel -eq $anchor) 'Statistics next week returns to the same range';Tap '.current-week'
      }
      # A separate synthetic long-history model gives both widths the same reproducible visual case.
      if($Mode -ne 'Gesture'){$null=Evaluate ($uxSources.seedLayout -replace '\r?\n',' ') @($uxSources.layout);Ux-Layout}
      $console=Invoke-Ide 'get_simulator_console' @('--command','grep -n .') -ProjectTool
      Save-Json $console (Join-Path $script:RunDirectory 'console-all.local.json')
      $currentManifest=@(Get-ChildItem (Join-Path $script:Project 'miniprogram') -Recurse -File|Sort-Object FullName|ForEach-Object {@{path=[IO.Path]::GetRelativePath($script:Project,$_.FullName);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
      Assert-That ((ConvertTo-Json $manifest -Compress) -eq (ConvertTo-Json $currentManifest -Compress)) 'Business source files stayed frozen throughout simulator acceptance'
      $script:State.outcome='interaction-pass-visual-review-required';$script:State.simulatorInteractionVerified=$true
    }
  }
}catch{$exitCode=1;if(-not $script:Pending){$script:State.outcome='failed'};$script:State.error=$_.Exception.Message;Write-Warning $_.Exception.Message}
finally{
  if($Mode -in @('Validate','Layout','Gesture') -and $script:State.restoreNeeded -and -not $script:Pending){
    try{Ux-RestoreProbe;Ux-RestoreInterface}catch{$exitCode=1;$script:State.outcome='restoration-required';$script:State.restoreNeeded=$true;$script:State.error=$_.Exception.Message;Write-Warning 'Keep the original backup and use Restore before another test.'}
  }
  $script:State.finished=(Get-Date).ToString('o');Save-State;Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
