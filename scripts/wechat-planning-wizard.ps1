#requires -Version 7.3
<# Run in an ordinary Windows host after npm checks and source freeze.
   Picker selection uses documented component change/columnchange events;
   it does not claim a human interaction with the native picker popup. #>
[CmdletBinding()]
param(
  [string]$Project=(Split-Path $PSScriptRoot -Parent),
  [string]$WechatIde='E:\Software\微信web开发者工具\wechatide.cmd',
  [ValidateSet('Validate','Layout','Sunshine','SwimOvertime','Restore','Poll')][string]$Mode='Validate',
  [ValidateSet('default','narrow')][string]$Label='default',
  [string]$RunDirectory
)
function Initialize-WizardEncoding { $script:OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) }
Initialize-WizardEncoding
$ErrorActionPreference='Stop';$PSNativeCommandUseErrorActionPreference=$false
$script:Project=(Resolve-Path -LiteralPath $Project).Path;$script:Token=$null;$script:Pending=$false;$script:Sequence=0
# Import definitions, never execute legacy entry points or change their recovery contract.
foreach($helper in @('wechat-smoke.ps1','wechat-ux.ps1')){
  $errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $helper),[ref]$null,[ref]$errors)
  if($errors.Count){throw 'Acceptance helper syntax error.'}
  foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
    if($helper -eq 'wechat-smoke.ps1' -or $fn.Name -in @('Ux-Page','Wait-UxPage','Ux-Go','Ux-Input','Ux-Expand','Ux-Trigger','Ux-Shot','Ux-Measure','Ux-RestoreAll','Ux-RestoreInterface')){. ([scriptblock]::Create($fn.Extent.Text))}
  }
}
$artifactRoot=Join-Path $script:Project 'artifacts/wechat-planning-wizard';$activeFile=Join-Path $artifactRoot 'active-run.json'
New-Item -ItemType Directory -Path $artifactRoot -Force|Out-Null
if($Mode -in @('Restore','Poll')){
  if(-not $RunDirectory){throw 'Recovery requires the original RunDirectory.'}
  $script:RunDirectory=(Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State=Get-Content -LiteralPath (Join-Path $script:RunDirectory 'state.json') -Raw -Encoding utf8|ConvertFrom-Json -AsHashtable
  if($script:State.project -ne $script:Project){throw 'Backup project mismatch.'}
  if($Mode -eq 'Restore' -and -not $script:State.restoreNeeded){throw 'No outstanding restoration; do not overwrite newer user data with an old backup.'}
  $script:Sequence=@(Get-ChildItem -LiteralPath $script:RunDirectory -Filter '*.log').Count
  $script:Pending=$null -ne $script:State.pendingTask -and $script:State.pendingTask.status -eq 'pending'
}else{
  foreach($kind in @('wechat-smoke','wechat-iteration','wechat-visual','wechat-ux','wechat-planning-wizard')){
    $marker=Join-Path $script:Project "artifacts/$kind/active-run.json"
    if(Test-Path -LiteralPath $marker){$previous=Get-Content -LiteralPath $marker -Raw -Encoding utf8|ConvertFrom-Json;if($previous.pending -or $previous.restoreNeeded){throw "Recover the previous $kind run before validation."}}
  }
  if(-not $RunDirectory){$RunDirectory=Join-Path $artifactRoot ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+$Label+'-'+$Mode.ToLowerInvariant())}
  if(Test-Path -LiteralPath (Join-Path $RunDirectory 'state.json')){throw 'Use a new run directory.'}
  New-Item -ItemType Directory -Path $RunDirectory -Force|Out-Null;$script:RunDirectory=(Resolve-Path -LiteralPath $RunDirectory).Path
  $script:State=@{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';label=$Label;mode=$Mode;restoreNeeded=$false;assertions=@();pendingTask=$null;realDeviceVerified=$false;nativePickerPopupVerified=$false;componentPickerEvents=$true;cloudVerified=$false;mocked=@();controlledConfirmationResponses=$true}
}
$sources=(& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js')|Out-String)|ConvertFrom-Json -AsHashtable
if($LASTEXITCODE -ne 0){throw 'Backup helper generation failed.'}
$restoreSources=(& node (Join-Path $PSScriptRoot 'acceptance-restore-transport.js')|Out-String)|ConvertFrom-Json -AsHashtable
if($LASTEXITCODE -ne 0 -or $restoreSources.maxChunk -ne 8192){throw 'Restore transport helper generation failed.'}
$wizardSources=(& node (Join-Path $PSScriptRoot 'wizard-acceptance-fixtures.js') (Get-Date).ToString('yyyy-MM-dd')|Out-String)|ConvertFrom-Json -AsHashtable
if($LASTEXITCODE -ne 0 -or $wizardSources.basic.values['dayflow.plans.v1'].schedules[0].title -ne '上午工作'){throw 'Fixture generation or UTF8 decoding failed before storage access.'}
$sunSources=$null
if($Mode -in @('Sunshine','SwimOvertime')){
  $sunSources=(& node (Join-Path $PSScriptRoot 'sunshine-acceptance-fixtures.js') (Get-Date).ToString('yyyy-MM-dd')|Out-String)|ConvertFrom-Json -AsHashtable
  if($LASTEXITCODE -ne 0 -or $sunSources.sunshine.values['dayflow.plans.v1'].name -ne '阳光节奏合成验收'){throw 'Sunshine fixture generation or UTF8 decoding failed before storage access.'}
}
function Wz-Data { return Ux-Page '#schedule-editor' 'editorStep' }
function Wz-Manifest { return @(Get-ChildItem (Join-Path $script:Project 'miniprogram') -Recurse -File|Sort-Object FullName|ForEach-Object {@{path=[IO.Path]::GetRelativePath($script:Project,$_.FullName);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}}) }
function Wz-Snapshot {
  return Evaluate "function(date){var v=wx.getStorageSync('dayflow.instances.v1')||{};return {dayflowSmoke:true,plan:JSON.stringify(wx.getStorageSync('dayflow.plans.v1')),versions:JSON.stringify(wx.getStorageSync('dayflow.planVersions.v1')),records:JSON.stringify(wx.getStorageSync('dayflow.records.v2')),history:JSON.stringify(v[date])};}" @($wizardSources.basic.historyDate)
}
function Wz-Equal($Before,$After,[string[]]$Keys,[string]$Message){foreach($key in $Keys){Assert-That ($Before[$key] -eq $After[$key]) ($Message+': '+$key)}}
function Wz-Count([string]$Selector){
  $result=Evaluate "function(selector){return new Promise(function(resolve){wx.createSelectorQuery().selectAll(selector).boundingClientRect(function(nodes){resolve({dayflowSmoke:true,count:nodes.length});}).exec();});}" @($Selector)
  return [int]$result.count
}
function Wz-Modal([bool]$Confirm){
  $file=Join-Path $script:RunDirectory ('modal-'+[guid]::NewGuid().ToString('N')+'.json');Save-Json @{confirm=$Confirm;cancel=(-not $Confirm)} $file
  # Mark intent before the tool call, including a possible pending response.
  if(@($script:State.mocked) -notcontains 'showModal'){$script:State.mocked=@('showModal');Save-State}
  $null=Invoke-Ide 'automation_wx_api' @('--action','mock','--method','showModal','--result-file',$file) -ProjectTool
}
function Wz-RestoreApis {
  foreach($method in @($script:State.mocked|Where-Object {$_})){$null=Invoke-Ide 'automation_wx_api' @('--action','restore','--method',$method) -ProjectTool}
  $script:State.mocked=@();Save-State
}
function Wz-RestoreInterface {Wz-RestoreApis;Ux-RestoreInterface}
function Get-RestoreTextHash([string]$Text){
  [uint64]$hash=2166136261
  for($i=0;$i -lt $Text.Length;$i++){$hash=(($hash -bxor [uint64][int][char]$Text[$i])*[uint64]16777619) -band [uint64]4294967295}
  return ('{0:x8}' -f $hash)
}
function Split-RestoreText([string]$Text){
  $chunks=[Collections.Generic.List[string]]::new();$offset=0
  while($offset -lt $Text.Length){
    $length=[math]::Min(8192,$Text.Length-$offset)
    if($offset+$length -lt $Text.Length -and [char]::IsHighSurrogate($Text[$offset+$length-1])){$length--}
    $chunks.Add($Text.Substring($offset,$length));$offset+=$length
  }
  return ,$chunks.ToArray()
}
# Overrides the imported storage restore only within this acceptance entry point.
# Ux-RestoreInterface still performs both restores and the real-day navigation.
function Ux-RestoreAll {
  $text=[IO.File]::ReadAllText((Join-Path $script:RunDirectory 'all-dayflow-backup.json'),[Text.Encoding]::UTF8)
  $chunks=Split-RestoreText $text;$nonce=[guid]::NewGuid().ToString('N')
  if($script:State.restoreTransportNonce){
    $aborted=Evaluate ($restoreSources.abort -replace '\r?\n',' ') @($script:State.restoreTransportNonce)
    if(-not $aborted.aborted){throw 'The previous restore transfer could not be cleared safely.'}
    $script:State.restoreTransportNonce=$null;Save-State
  }
  $script:State.restoreTransportNonce=$nonce;Save-State
  try {
    $meta=@{nonce=$nonce;total=$chunks.Count;chars=$text.Length;hash=(Get-RestoreTextHash $text)}
    $begun=Evaluate ($restoreSources.begin -replace '\r?\n',' ') @($meta)
    if(-not $begun.begun -or $begun.total -ne $chunks.Count -or $begun.chars -ne $text.Length){throw 'Restore transfer metadata was not acknowledged.'}
    for($index=0;$index -lt $chunks.Count;$index++){
      $part=$chunks[$index];$packet=@{nonce=$nonce;index=$index;total=$chunks.Count;chars=$part.Length;hash=(Get-RestoreTextHash $part);text=$part}
      $ack=Evaluate ($restoreSources.part -replace '\r?\n',' ') @($packet)
      if($ack.index -ne $index -or $ack.received -ne $index+1 -or $ack.chars -ne $part.Length){throw 'Restore transfer chunk was not acknowledged.'}
    }
    $result=Evaluate ($restoreSources.finish -replace '\r?\n',' ') @($nonce)
    $script:State.restoreTransportNonce=$null;Save-State
    Assert-That ($result.equal -eq $true) 'All original Dayflow keys and values restored with exact read-back'
  }catch{
    if(-not $script:Pending){try{$ack=Evaluate ($restoreSources.abort -replace '\r?\n',' ') @($nonce);if($ack.aborted){$script:State.restoreTransportNonce=$null;Save-State}}catch{}}
    throw
  }
}
function Wz-Seed([string]$Scenario){
  $seeded=Evaluate ($wizardSources.seedWizard -replace '\r?\n',' ') @($wizardSources[$Scenario]);Assert-That $seeded.seeded ('Synthetic fixture installed: '+$Scenario)
  # Drop cached tabs/drafts so every case observes the actual seeded storage.
  $null=Invoke-Ide 'automation_navigate' @('--action','reLaunch','--url','/pages/plans/index') -ProjectTool
  $null=Wait-UxPage 'pages/plans/index' '.create-schedule' 'schedules'
}
function Wz-New([string]$Name){Tap '.create-schedule';Ux-Input '.schedule-name' $Name;$p=Wz-Data;Assert-That ($p.editorStep -eq 0 -and $p.title -eq $Name) 'Name entry starts on step one';return $p}
function Wz-Next([int]$Expected){Tap '.wizard-next';$p=Wz-Data;Assert-That ($p.editorStep -eq $Expected) ('Wizard advances to step '+$Expected);return $p}
function Wz-Time([string]$Which,[string]$Value){
  if($Which -notin @('start','end') -or $Value -notmatch '^\d{2}:\d{2}$'){throw 'Invalid picker request.'}
  $p=Wz-Data;$range=$p[$Which+'TimeRange'];$parts=$Value.Split(':');$hour=[array]::IndexOf([object[]]$range[0],$parts[0])
  Assert-That ($hour -ge 0) ('Requested legal '+$Which+' hour exists: '+$Value)
  Ux-Trigger ('.'+$Which+'-time-picker') 'columnchange' @{column=0;value=$hour}
  $p=Wz-Data;$range=$p[$Which+'TimeRange'];$minute=[array]::IndexOf([object[]]$range[1],$parts[1])
  Assert-That ($minute -ge 0) ('Requested legal '+$Which+' minute exists: '+$Value)
  Ux-Trigger ('.'+$Which+'-time-picker') 'change' @{value=@($hour,$minute)}
  $p=Wz-Data;Assert-That ($p[$Which] -eq $Value) ('Component picker commits legal '+$Which+' '+$Value);return $p
}
function Wz-Layout([string]$Name,[string[]]$Controls){
  $boxes=Ux-Measure $Name (@('#schedule-editor','.wizard-summary','.wizard-footer')+$Controls)
  foreach($i in 3..($boxes.rects.Count-1)){foreach($r in @($boxes.rects[$i])){Assert-That ($r.width -ge 44 -and $r.height -ge 44) ('At least 44px control: '+$Controls[$i-3]);Assert-That ($r.bottom -le $boxes.height+1 -or $Controls[$i-3] -notin @('.wizard-next','.wizard-back','.save-schedule')) 'Fixed footer controls fit the actual window'}}
  Ux-Shot $Name '#schedule-editor'
}
function Wz-Basic {
  Wz-Seed 'basic';$before=Wz-Snapshot
  $null=Wz-New '验收合成的午间练习：整理本周事项并准备下一周';Wz-Layout 'name' @('.schedule-name','.wizard-next')
  $p=Wz-Next 1
  Assert-That (-not $p.occupiedVisible) 'Busy details start collapsed in the simple time page'
  Assert-That (@($p.occupiedSlots|Where-Object {$_.title -eq '上午工作' -and $_.start -eq '08:00' -and $_.end -eq '12:00'}).Count -gt 0) 'Occupied list names the 08:00-12:00 work plan'
  Assert-That (@($p.occupiedSlots|Where-Object {$_.title -eq '下午工作' -and $_.start -eq '14:00' -and $_.end -eq '18:00'}).Count -gt 0 -and @($p.occupiedSlots|Where-Object {$_.title -eq '午休'}).Count -gt 0) 'Multiple occupying plans each keep their own names and exact ranges'
  Assert-That (@($p.freeWindows|Where-Object {$_.start -eq '12:00' -and $_.end -eq '13:00'}).Count -gt 0) 'The actual noon free gap is listed separately from selectable replacement times'
  foreach($hour in @('08','09','10','11')){Assert-That ($hour -in $p.startTimeRange[0]) ('External occupied hour remains selectable for an explicitly confirmed replacement: '+$hour)}
  Assert-That ('12' -in $p.startTimeRange[0]) '12:00 boundary remains selectable'
  $null=Wz-Time 'start' '12:00';$p=Wz-Time 'end' '12:30'
  $validStart=$p.start;Ux-Trigger '.start-time-picker' 'change' @{value=@(999,999)};$p=Wz-Data
  Assert-That ($p.start -eq $validStart -and $p.editorStep -eq 1 -and $p.wizardError) 'Invalid picker indices cannot select an occupied/unknown time and explain rejection'
  Wz-Layout 'time' @('.start-time-picker','.end-time-picker','.wizard-back','.wizard-next')
  Tap '.wizard-back';$p=Wz-Data;Assert-That ($p.editorStep -eq 0 -and $p.title -like '验收合成的午间练习*') 'Back retains the entered name'
  $p=Wz-Next 1;Assert-That ($p.start -eq '12:00' -and $p.end -eq '12:30') 'Returning to time retains the selected range'
  $p=Wz-Next 2;Assert-That ($p.repeatModeIndex -eq 0 -and -not $p.exceptionEditorVisible) 'One-day arrangement has no exception editor'
  Assert-That ((Wz-Count '.exception-toggle') -eq 0 -and (Wz-Count '.add-exception') -eq 0) 'Ordinary filling has no special-date controls'
  Wz-Modal $false;Tap ".repeat-option[data-index='1']";$p=Wz-Data;Wz-RestoreApis
  Assert-That (@($p.overwriteRows|Where-Object {$_.title -eq '两个月后会议' -and $_.start -eq '12:00' -and $_.end -eq '13:00'}).Count -gt 0) 'Expanding repeat identifies the complete future meeting that replacement would remove'
  Assert-That ($p.overwriteRequired -and -not $p.overwriteConfirmed) 'Cancelling confirmation leaves the replacement unapproved'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Cancelling replacement changes no stored arrangement or record'
  Tap '.wizard-back';$p=Wz-Data;Assert-That ($p.editorStep -eq 1 -and '12' -in $p.startTimeRange[0]) 'External occupation does not force repeated weekday-by-weekday time editing'
  Tap '.wizard-back';$null=Wz-Next 1
  # Re-enter repeat through the retained draft; changing repeat repairs scope only.
  # The controller permits the repeat step already reached, even when time is invalid.
  Tap ".wizard-step[data-step='2']";Tap ".repeat-option[data-index='0']";$p=Wz-Data
  Assert-That ($p.editorStep -eq 2 -and $p.repeatModeIndex -eq 0) 'One-day repeat can be restored without losing the draft'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Before final confirmation storage stays unchanged'
  Wz-Layout 'repeat' @('.repeat-option','.wizard-back','.wizard-next')
  $p=Wz-Next 3;Assert-That (@($p.summaryRows).Count -gt 0 -and @($p.reviewBlocks).Count -eq 1) 'Confirmation presents the complete saved draft'
  Wz-Layout 'review' @('.wizard-back','.save-schedule')
  Tap '.wizard-back';$p=Wz-Data;Assert-That ($p.editorStep -eq 2 -and $p.title -like '验收合成的午间练习*' -and $p.start -eq '12:00') 'Review back preserves all entered fields'
  $null=Wz-Next 3;Tap '.save-schedule';$p=Ux-Page '.create-schedule' 'editorVisible';Assert-That (-not $p.editorVisible) 'Only final confirmation saves and closes the wizard'
  $after=Wz-Snapshot;Assert-That ($after.plan -ne $before.plan) 'Final confirmation persists the new arrangement'
  Wz-Equal $before $after @('records','history') 'New future plan preserves historical execution data'
}
function Wz-Existing {
  Wz-Seed 'basic';$before=Wz-Snapshot
  Tap ".schedule-edit[data-id='wizard-work-am']";$p=Wz-Next 1
  Assert-That ('08' -in $p.startTimeRange[0] -and '14' -in $p.startTimeRange[0] -and @($p.occupiedSlots|Where-Object {$_.title -eq '上午工作'}).Count -eq 0 -and @($p.occupiedSlots|Where-Object {$_.title -eq '下午工作' -and $_.start -eq '14:00' -and $_.end -eq '18:00'}).Count -gt 0) 'Editing excludes its own old occupation; another plan remains named and selectable only with explicit replacement'
  Tap '.close-editor';Tap '.resume-draft';$p=Wz-Data;Assert-That ($p.editorStep -eq 1 -and $p.start -eq '08:00') 'Closing then resuming keeps the in-memory step and time draft'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Closing or resuming never saves the draft'
  $null=Invoke-Ide 'automation_navigate' @('--action','reLaunch','--url','/pages/plans/index') -ProjectTool;$null=Wait-UxPage 'pages/plans/index' '.create-schedule' 'schedules'
  Tap ".schedule-edit[data-id='wizard-complex']";$p=Wz-Next 1
  Assert-That ('20' -in $p.startTimeRange[0] -and @($p.occupiedSlots|Where-Object {$_.title -eq '睡前阅读' -and $_.start -eq '20:30'}).Count -gt 0) 'Complex edit keeps sibling occupation while excluding the selected block'
  $null=Wz-Next 2;Tap '.advanced-toggle';Tap '.advanced-toggle';$null=Wz-Next 3;Tap '.save-schedule'
  $p=Ux-Page '.create-schedule' 'editorVisible';Assert-That (-not $p.editorVisible) 'Existing complex schedule saves through the confirmation page'
  $after=Wz-Snapshot;$original=$before.plan|ConvertFrom-Json -AsHashtable;$saved=$after.plan|ConvertFrom-Json -AsHashtable
  $old=@($original.schedules|Where-Object {$_.id -eq 'wizard-complex'})[0];$new=@($saved.schedules|Where-Object {$_.id -eq 'wizard-complex'})[0]
  Assert-That ((ConvertTo-Json $old.blocks -Depth 70 -Compress) -eq (ConvertTo-Json $new.blocks -Depth 70 -Compress)) 'Complex actions, optional fields, sibling blocks and origin survive a round trip'
  Assert-That ((ConvertTo-Json $old.exceptions -Depth 70 -Compress) -eq (ConvertTo-Json $new.exceptions -Depth 70 -Compress) -and @($new.exceptions).Count -eq 2) 'Existing date adjustments remain unchanged without exposing exception editing controls'
  Wz-Equal $before $after @('records','history') 'Complex editing preserves historical execution data'
}
function Wz-NoGap {
  Wz-Seed 'siblings';$before=Wz-Snapshot;Tap ".schedule-edit[data-id='wizard-full']";$p=Wz-Next 1
  Assert-That (@($p.freeWindows).Count -eq 0 -and @($p.startTimeRange[0]).Count -eq 0 -and $p.wizardNextDisabled) 'A fully occupying sibling exposes no legal time and cannot be silently overwritten'
  Assert-That (@($p.occupiedSlots|Where-Object {$_.title -eq '同组全天安排' -and $_.start -eq '00:00' -and $_.end -eq '24:00'}).Count -gt 0 -and $p.timeAvailabilityError) 'The no-gap page names the occupying sibling and its exact range'
  Wz-Layout 'no-gap' @('.wizard-back','.wizard-next');Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Unavailable draft never writes storage'
}
function Wz-RejectedFinalSave([string]$Kind){
  Wz-Seed 'basic';$null=Wz-New ('最终保存复查'+$Kind);$null=Wz-Next 1;$null=Wz-Time 'start' '06:00';$null=Wz-Time 'end' '06:30';$null=Wz-Next 2;$null=Wz-Next 3
  if($Kind -eq 'version'){
    $null=Evaluate "function(){var p=wx.getStorageSync('dayflow.plans.v1');p.version+=1;p.updatedAt=Date.now();wx.setStorageSync('dayflow.plans.v1',p);return {dayflowSmoke:true};}"
  }elseif($Kind -eq 'locked'){
    $null=Evaluate "function(date){var v=wx.getStorageSync('dayflow.instances.v1');if(!v||!v[date])throw new Error('Expected actual current instance');v[date].locked=true;wx.setStorageSync('dayflow.instances.v1',v);return {dayflowSmoke:true};}" @($wizardSources.basic.date)
  }else{throw 'Unknown final-save guard.'}
  $before=Wz-Snapshot;Tap '.save-schedule';$p=Wz-Data
  Assert-That ($p.editorVisible -and $p.title -eq ('最终保存复查'+$Kind) -and $p.start -eq '06:00' -and ($p.errorMessage -or $p.wizardError)) ('Final '+$Kind+' check rejects save and preserves the entered draft')
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') ('Rejected '+$Kind+' save writes no plan/version/record/history')
  Assert-That (($p.errorMessage+' '+$p.wizardError) -notmatch '(targetId|blockId|scheduleId|目标冲突)') 'User-facing rejection does not expose internal target identifiers'
}
function Wz-Identity {
  Wz-Seed 'identity';$before=Wz-Snapshot;Tap ".schedule-edit[data-id='wizard-identity-a']";$null=Wz-Next 1;$null=Wz-Next 2
  Tap ".repeat-option[data-index='1']";$p=Wz-Next 3;Assert-That (@($p.conflicts).Count -eq 0) 'Expanding a disjoint identity rule has no artificial target conflict'
  Tap '.save-schedule';$p=Ux-Page '.create-schedule' 'editorVisible';Assert-That (-not $p.editorVisible) 'Service safely resolves reused identifiers when repeat expands'
  $after=Wz-Snapshot;$template=$after.plan|ConvertFrom-Json -AsHashtable;$a=@($template.schedules|Where-Object {$_.id -eq 'wizard-identity-a'})[0];$b=@($template.schedules|Where-Object {$_.id -eq 'wizard-identity-b'})[0]
  Assert-That ($a.blocks[0].id -ne $b.blocks[0].id -and $a.blocks[0].tasks[0].id -ne $b.blocks[0].tasks[0].id) 'Overlapping-date rules receive independent block and task identities'
  Wz-Equal $before $after @('records','history') 'Identity separation leaves historical references unchanged'
}
function Wz-Overwrite {
  Wz-Seed 'overwrite';$before=Wz-Snapshot;$null=Wz-New '合成验收：每天上午集中安排';$null=Wz-Next 1
  Ux-Trigger '.schedule-date-picker' 'change' @{value=$wizardSources.overwrite.sundayDate}
  $null=Wz-Time 'start' '08:00';$p=Wz-Time 'end' '12:00';$null=Wz-Next 2
  Wz-Modal $true;Tap ".repeat-option[data-index='1']";$p=Wz-Data;Wz-RestoreApis
  Assert-That ($p.overwriteConfirmed -and -not $p.overwriteRequired -and @($p.overwriteRows).Count -eq 1) 'One controlled confirmation approves all affected weekdays together'
  $removed=$p.overwriteRows[0]
  Assert-That ($removed.blockId -eq 'wizard-weekday-am' -and $removed.start -eq '09:00' -and $removed.end -eq '12:00' -and @($removed.weekdays).Count -eq 5) 'Replacement preview names the entire old 09:00-12:00 block and its five-day repeat scope'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Accepting replacement only approves the draft and writes nothing'
  Wz-Modal $false;Tap ".repeat-option[data-index='2']";$p=Wz-Data;Wz-RestoreApis
  Assert-That ($p.overwriteRequired -and -not $p.overwriteConfirmed) 'Changing repeat scope invalidates the earlier approval'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Cancelling the changed scope keeps the original plan'
  Wz-Modal $true;Tap ".repeat-option[data-index='1']";$p=Wz-Data;Wz-RestoreApis
  Assert-That $p.overwriteConfirmed 'The final repeat scope receives a fresh explicit confirmation'
  $null=Wz-Next 3;Wz-Layout 'overwrite-review' @('.wizard-back','.save-schedule')
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Even the approved confirmation page has not persisted changes'
  Tap '.save-schedule';$p=Ux-Page '.create-schedule' 'editorVisible';Assert-That (-not $p.editorVisible) 'Final save commits the confirmed replacement once'
  $after=Wz-Snapshot;$original=$before.plan|ConvertFrom-Json -AsHashtable;$saved=$after.plan|ConvertFrom-Json -AsHashtable
  foreach($weekday in 1..5){
    $date=Local-DatePlus $wizardSources.overwrite.sundayDate $weekday
    $active=@($saved.schedules|Where-Object {$_.effectiveFrom -le $date -and (-not $_.effectiveTo -or $_.effectiveTo -ge $date) -and $weekday -in $_.weekdays})
    $blocks=@($active|ForEach-Object {$_.blocks})
    Assert-That (@($blocks|Where-Object {$_.id -eq 'wizard-weekday-am' -or $_.title -eq '上午工作'}).Count -eq 0 -and @($blocks|Where-Object {$_.id -eq 'wizard-weekday-pm' -and $_.start -eq '14:00' -and $_.end -eq '18:00'}).Count -eq 1) ('The entire old morning is removed and afternoon retained on affected weekday '+$weekday)
  }
  $oldOther=@($original.schedules|Where-Object {$_.id -eq 'wizard-unrelated'})[0];$newOther=@($saved.schedules|Where-Object {$_.id -eq 'wizard-unrelated'})[0]
  Assert-That ((ConvertTo-Json $oldOther -Depth 70 -Compress) -eq (ConvertTo-Json $newOther -Depth 70 -Compress)) 'An unrelated task and its identity remain unchanged'
  $new=@($saved.schedules|Where-Object {@($_.blocks|Where-Object {$_.title -eq '合成验收：每天上午集中安排'}).Count -gt 0})
  Assert-That ($new.Count -eq 1 -and @($new[0].weekdays).Count -eq 7 -and $new[0].blocks[0].start -eq '08:00' -and $new[0].blocks[0].end -eq '12:00' -and $saved.version -eq $original.version+1) 'One new daily 08:00-12:00 arrangement is stored with a single version increment'
  Wz-Equal $before $after @('records','history') 'Replacement preserves completed execution and locked historical snapshots'
}
function Wz-ExternalFull {
  Wz-Seed 'full';$before=Wz-Snapshot;Wz-Modal $false;$null=Wz-New '合成验收：替换外部全天安排';$p=Wz-Next 1
  Assert-That ('12' -in $p.startTimeRange[0]) 'An external all-day occupation does not disable the selected time'
  $null=Wz-Time 'start' '12:00';$p=Wz-Time 'end' '12:30';Wz-RestoreApis
  Assert-That ($p.overwriteRequired -and -not $p.overwriteConfirmed -and @($p.overwriteRows|Where-Object {$_.title -eq '全天工作' -and $_.start -eq '00:00' -and $_.end -eq '24:00'}).Count -eq 1) 'Replacing an external full day requires explicit approval of deleting its whole time block'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'An unapproved full-day replacement changes no saved data'
}
function Wz-RestSnapshot {
  return Evaluate "function(date,historyDate){var r=wx.getStorageSync('dayflow.records.v2');var rest=wx.getStorageSync('dayflow.restDays.v1');return {dayflowSmoke:true,plan:JSON.stringify(wx.getStorageSync('dayflow.plans.v1')),versions:JSON.stringify(wx.getStorageSync('dayflow.planVersions.v1')),snapshots:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')),done:JSON.stringify(r.byDate[date]['wizard-action-a']),history:JSON.stringify(r.byDate[historyDate]),records:JSON.stringify(r),doing:r.byDate[date]['wizard-action-b'],todo:r.byDate[date]['wizard-action-c']||null,timer:wx.getStorageSync('dayflow.timer.v1'),rest:rest&&rest.byDate?rest.byDate[date]:null};}" @($wizardSources.rest.date,$wizardSources.rest.historyDate)
}
function Wz-RestLayout([string]$Name,[string]$Anchor,[string[]]$Controls){
  $boxes=Ux-Measure $Name (@($Anchor)+$Controls)
  foreach($i in 1..($boxes.rects.Count-1)){foreach($r in @($boxes.rects[$i])){Assert-That ($r.width -ge 44 -and $r.height -ge 44) ('At least 44px rest control: '+$Controls[$i-1])}}
  Ux-Shot $Name $Anchor
}
function Wz-Rest {
  Wz-Seed 'rest'
  $p=Ux-Go 'pages/today/index' '.rest-day-open' 'restActive'
  Assert-That (-not $p.restActive -and $p.heroTitle -eq '收好物品') 'Original running task is visible before choosing rest'
  # Today foreground reminders may derive tomorrow's unlocked cache (Sunday -> Monday).
  # Capture after entering Today, still before any rest interaction; keep full snapshot equality.
  $before=Wz-RestSnapshot
  Tap '.rest-day-open';$p=Ux-Page '.rest-day-confirm' 'restEditorVisible'
  Assert-That ($p.restEditorVisible -and -not $p.restReasonInput) 'Rest opens with an optional empty reason'
  Tap '.rest-day-cancel';Wz-Equal $before (Wz-RestSnapshot) @('plan','versions','snapshots','records') 'Cancelling rest writes no plan or execution data'
  Tap '.rest-day-open';Ux-Input '.rest-day-reason' '合成验收：今天有事，先休息一下，明天照常。'
  Wz-RestLayout 'rest-form' '.rest-card' @('.rest-day-reason','.rest-day-confirm','.rest-day-cancel')
  Tap '.rest-day-confirm';$p=Ux-Page '.rest-day-resume' 'restActive';$after=Wz-RestSnapshot
  Assert-That ($p.restActive -and $p.heroTitle -eq '今天休息' -and $p.restReason -eq '合成验收：今天有事，先休息一下，明天照常。') 'One confirmation pauses today and displays the entered reason'
  Assert-That ($after.rest.active -and $after.doing.status -eq 'aborted' -and $after.doing.events[-1].from -eq 'doing' -and $after.doing.events[-1].to -eq 'aborted' -and $after.todo -eq $null) 'Only running work receives a real stop event; untouched tasks receive no fabricated skipped record'
  Assert-That ($after.timer.status -eq 'paused' -and $after.timer.remainingSeconds -gt 0 -and -not $after.timer.endsAt) 'An active independent countdown pauses with time remaining'
  Wz-Equal $before $after @('plan','versions','snapshots','done','history') 'Today rest preserves templates, snapshots, completed records and historical execution'
  Assert-That (-not $p.reminderText -and @($p.blocks|Where-Object {$_.stateText -ne '今日休息'}).Count -eq 0) 'All original time blocks including fixed occupation show today rest without foreground reminders'
  Wz-RestLayout 'rest-active' '.rest-card' @('.rest-day-resume')
  Tap ".block-header[data-id='wizard-sequence']";Tap ".check-button[data-id='wizard-action-c']"
  Wz-Equal $after (Wz-RestSnapshot) @('records','done','history') 'Tapping an unfinished item cannot complete it while resting'
  $other=@($p.week|Where-Object {$_.date -ne $wizardSources.rest.date})[0].date
  Tap (".weekday[data-date='"+$other+"']");$p=Ux-Page '.weekday' 'selectedDate'
  Assert-That (-not $p.isToday -and -not $p.restActive -and (Wz-Count '.rest-day-open') -eq 0 -and (Wz-Count '.rest-day-resume') -eq 0) 'Other dates do not inherit today rest controls'
  Tap '.today-jump';$p=Ux-Page '.rest-day-resume' 'restActive';Assert-That $p.restActive 'Returning to today retains its stored rest state'
  $null=Invoke-Ide 'automation_navigate' @('--action','navigateTo','--url',('/pages/training/index?date='+$wizardSources.rest.date+'&blockId=wizard-sequence')) -ProjectTool
  $p=Wait-UxPage 'pages/training/index' '.rest-day-notice' 'restActive'
  Assert-That ($p.restActive -and $p.restReason -eq '合成验收：今天有事，先休息一下，明天照常。') 'Task details reflect the same day rest state'
  Tap ".check[data-id='wizard-action-c']";Wz-Equal $after (Wz-RestSnapshot) @('records','done','history') 'The detail completion entry also refuses to execute during rest'
  Wz-RestLayout 'rest-detail' '.rest-day-notice' @('.view-rest-day')
  Tap '.view-rest-day';$p=Wait-UxPage 'pages/today/index' '.rest-day-resume' 'restActive';$beforeResume=Wz-RestSnapshot
  Tap '.rest-day-resume';$p=Ux-Page '.rest-day-open' 'restActive';$resumed=Wz-RestSnapshot
  Assert-That (-not $p.restActive -and -not $resumed.rest.active -and $resumed.timer.status -eq 'paused' -and $resumed.doing.status -eq 'aborted') 'Resume restores availability without automatically restarting tasks or timer'
  Wz-Equal $beforeResume $resumed @('plan','versions','snapshots','done','history','records') 'Resuming changes only the rest setting'
}
function Sz-Seed([string]$Scenario){
  $seeded=Evaluate ($sunSources.seedWizard -replace '\r?\n',' ') @($sunSources[$Scenario]);Assert-That $seeded.seeded ('Sunshine synthetic fixture installed: '+$Scenario)
  $null=Invoke-Ide 'automation_navigate' @('--action','reLaunch','--url','/pages/plans/index') -ProjectTool
  $null=Wait-UxPage 'pages/plans/index' '.create-schedule' 'schedules'
}
function Sz-RepeatBoundary {
  Sz-Seed 'empty';$before=Wz-Snapshot;$p=Wz-New '合成验收：夜间整理，次日继续保持好状态'
  Assert-That ($p.repeatModeIndex -eq 0) 'A new arrangement begins with the explicit non-repeating option'
  $null=Wz-Next 1
  Ux-Trigger '.schedule-date-picker' 'change' @{value=$sunSources.empty.wednesdayDate}
  $null=Wz-Time 'start' '23:00';$p=Wz-Time 'end' '24:00'
  Assert-That ($p.end -eq '24:00' -and '24' -notin $p.startTimeRange[0]) 'A real end picker accepts exactly midnight while start candidates cannot be 24:00'
  $null=Wz-Next 2;Tap ".repeat-option[data-index='4']";$p=Wz-Data
  Assert-That ($p.repeatModeIndex -eq 4 -and @($p.selectedWeekdays).Count -eq 1 -and $p.selectedWeekdays[0] -eq 3 -and @($p.repeatChoices|Where-Object {$_.value -eq 4 -and $_.label -eq '每周三'}).Count -eq 1) 'The selected Wednesday offers and selects a direct weekly-Wednesday choice'
  Tap '.wizard-back';Ux-Trigger '.schedule-date-picker' 'change' @{value=$sunSources.empty.thursdayDate};$null=Wz-Next 2;$p=Wz-Data
  Assert-That ($p.selectedWeekdays[0] -eq 4 -and @($p.repeatChoices|Where-Object {$_.value -eq 4 -and $_.label -eq '每周四'}).Count -eq 1) 'Changing the arrangement date updates its weekly weekday without clearing the clock range'
  Tap ".repeat-option[data-index='2']";$p=Wz-Data
  Assert-That (@($p.selectedWeekdays).Count -eq 5 -and (0 -notin $p.selectedWeekdays) -and (6 -notin $p.selectedWeekdays)) 'Workdays mean Monday through Friday'
  Tap ".repeat-option[data-index='5']";$p=Wz-Data
  Assert-That (@($p.selectedWeekdays).Count -eq 2 -and (0 -in $p.selectedWeekdays) -and (6 -in $p.selectedWeekdays)) 'Non-workdays mean Saturday and Sunday without assuming public-holiday adjustments'
  Tap ".repeat-option[data-index='1']";$p=Wz-Data
  Assert-That (@($p.selectedWeekdays).Count -eq 7) 'Every day selects all seven weekdays'
  Tap ".repeat-option[data-index='4']";Wz-Layout 'sunshine-repeat' @('.repeat-option','.wizard-back','.wizard-next')
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Weekly choices and midnight stay in the draft until final confirmation'
  $null=Wz-Next 3;Wz-Layout 'sunshine-midnight-review' @('.save-schedule','.wizard-back');Tap '.save-schedule'
  $p=Ux-Page '.create-schedule' 'editorVisible';Assert-That (-not $p.editorVisible) 'The midnight-ending weekly arrangement saves through the actual final button'
  $after=Wz-Snapshot;$saved=$after.plan|ConvertFrom-Json -AsHashtable
  $rule=@($saved.schedules|Where-Object {@($_.blocks|Where-Object {$_.title -eq '合成验收：夜间整理，次日继续保持好状态'}).Count -gt 0})
  Assert-That ($rule.Count -eq 1 -and $rule[0].blocks[0].start -eq '23:00' -and $rule[0].blocks[0].end -eq '24:00' -and @($rule[0].weekdays).Count -eq 1 -and $rule[0].weekdays[0] -eq 4) 'Persisted midnight end and current weekly weekday retain their exact values'
  Wz-Equal $before $after @('records','history') 'Saving the new weekly arrangement preserves real history'
}
function Sz-TemplatePreview {
  Sz-Seed 'sunshine';$before=Wz-Snapshot
  Tap '.plan-tools-toggle';Tap '.example-toggle';$p=Ux-Page '.example-schedules' 'exampleRows'
  Assert-That ($p.examplePreview -and $p.importPreview.ok -and $p.importPreview.template.version -eq 4) 'The new example is validated and previewed as version four'
  foreach($weekday in 0..6){
    $rule=@($p.importPreview.template.schedules|Where-Object {$weekday -in $_.weekdays})[0];$blocks=$rule.blocks
    Sw-CheckBlocks $blocks $weekday 'Version-four preview'
  }
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Viewing the new example changes no saved plan or execution history'
  if($Mode -eq 'SwimOvertime'){Ux-Shot 'swim-overtime-example-preview' '.example-schedules'}
}
function Sz-Page([string]$Name,[string]$Anchor,[string[]]$Controls){
  $boxes=Ux-Measure $Name (@($Anchor)+$Controls)
  foreach($i in 1..($boxes.rects.Count-1)){foreach($r in @($boxes.rects[$i])){Assert-That ($r.width -ge 44 -and $r.height -ge 44) ('At least 44px sunshine control: '+$Controls[$i-1])}}
  Ux-Shot $Name $Anchor
}
function Sz-EveningAdoption {
  Sz-Seed 'custom';$before=Wz-Snapshot
  $lockedBefore=Evaluate "function(date){return {dayflowSmoke:true,value:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')[date])};}" @($sunSources.custom.date)
  Tap '.plan-tools-toggle';Tap '.evening-update-toggle';$p=Ux-Page '.confirm-evening-update' 'eveningPreview'
  Assert-That ($p.eveningPreview -and $p.importPreview.ok) 'Existing custom plans can preview an evening-only update without using full template import'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Previewing an evening-only update changes nothing'
  Ux-Shot 'sunshine-evening-preview' '.import-panel'
  Wz-Modal $false;Tap '.confirm-evening-update';Wz-RestoreApis
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Cancelling the evening update preserves the whole original custom plan'
  Wz-Modal $true;Tap '.confirm-evening-update';Wz-RestoreApis;$p=Ux-Page '.create-schedule' 'templateVersion';$after=Wz-Snapshot
  $old=$before.plan|ConvertFrom-Json -AsHashtable;$saved=$after.plan|ConvertFrom-Json -AsHashtable
  Assert-That ($saved.version -eq $old.version+1) 'Confirming the evening-only update creates one plan version'
  foreach($weekday in 0..6){
    $date=Local-DatePlus $sunSources.custom.wednesdayDate $weekday
    $day=([datetime]::ParseExact($date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)).DayOfWeek.value__
    $active=@($saved.schedules|Where-Object {$_.effectiveFrom -le $date -and (-not $_.effectiveTo -or $_.effectiveTo -ge $date) -and $day -in $_.weekdays})
    $blocks=@($active|ForEach-Object {$exception=@($_.exceptions|Where-Object {$_.date -eq $date});if($exception.Count){if($exception[0].kind -eq 'replace'){$exception[0].blocks}}else{$_.blocks}})
    Assert-That (@($blocks|Where-Object {$_.id -eq 'work-morning' -and $_.title -eq '自定义白天工作' -and $_.start -eq '08:00' -and $_.end -eq '12:00'}).Count -eq 1) ('Evening adoption preserves custom 08:00-12:00 daytime work: '+$date)
    $swim=$day -in @(2,4,6);$training=@($blocks|Where-Object {$_.category -eq '训练'})
    Assert-That ($training.Count -eq 1 -and (($swim -and $training[0].start -eq '17:30' -and $training[0].end -eq '19:00') -or (-not $swim -and $training[0].start -eq '20:30' -and $training[0].end -eq '22:00'))) ('Evening adoption changes the future training window on '+$date)
    Sw-CheckBlocks $blocks $day 'Saved evening update'
  }
  $oldInterest=@($old.schedules|Where-Object {$_.id -eq 'sunshine-custom-interest'})[0];$newInterest=@($saved.schedules|Where-Object {$_.id -eq 'sunshine-custom-interest'})[0]
  Assert-That ((ConvertTo-Json $oldInterest -Depth 70 -Compress) -eq (ConvertTo-Json $newInterest -Depth 70 -Compress)) 'A separate personal-interest example and all its identities remain unchanged'
  $lockedAfter=Evaluate "function(date){return {dayflowSmoke:true,value:JSON.stringify(wx.getStorageSync('dayflow.instances.v1')[date])};}" @($sunSources.custom.date)
  Assert-That ($lockedAfter.value -eq $lockedBefore.value) 'The current completed day keeps its original locked snapshot'
  Wz-Equal $before $after @('records','history') 'Evening adoption preserves completed facts and historical snapshots'
}
function Sw-Minute([string]$Clock){$parts=$Clock.Split(':');return [int]$parts[0]*60+[int]$parts[1]}
function Sw-CheckBlocks($Blocks,[int]$Weekday,[string]$Context){
  $swim=$Weekday -in @(2,4,6);$training=@($Blocks|Where-Object {$_.category -eq '训练'});$overtime=@($Blocks|Where-Object {$_.category -eq '加班'})
  Assert-That ($training.Count -eq 1 -and $training[0].kind -eq 'sequence' -and ((Sw-Minute $training[0].end)-(Sw-Minute $training[0].start)) -eq 90) ($Context+' reserves ninety minutes for exercise: '+$Weekday)
  Assert-That ($overtime.Count -eq 1 -and $overtime[0].kind -eq 'fixed' -and @($overtime[0].tasks|Where-Object {$_}).Count -eq 0 -and @($overtime[0].actions|Where-Object {$_}).Count -eq 0) ($Context+' keeps overtime fixed without task check-ins: '+$Weekday)
  if($swim){
    Assert-That ($training[0].start -eq '17:30' -and $training[0].end -eq '19:00' -and $overtime[0].start -eq '19:30' -and $overtime[0].end -eq '21:30') ($Context+' swims before returning to overtime: '+$Weekday)
    Assert-That (@($Blocks|Where-Object {$_.kind -eq 'fixed' -and $_.title -eq '下班直接去游泳' -and $_.start -eq '17:00' -and $_.end -eq '17:30'}).Count -eq 1 -and @($Blocks|Where-Object {$_.kind -eq 'fixed' -and $_.title -eq '游泳后返回工作地点' -and $_.start -eq '19:00' -and $_.end -eq '19:30'}).Count -eq 1 -and @($Blocks|Where-Object {$_.kind -eq 'fixed' -and $_.title -eq '加班后回家' -and $_.start -eq '21:30' -and $_.end -eq '22:00'}).Count -eq 1) ($Context+' includes pool, workplace and home travel in order: '+$Weekday)
  }else{
    Assert-That ($overtime[0].start -eq '17:00' -and $overtime[0].end -eq '20:00' -and $training[0].start -eq '20:30' -and $training[0].end -eq '22:00' -and @($Blocks|Where-Object {$_.kind -eq 'fixed' -and $_.title -eq '加班后回家' -and $_.start -eq '20:00' -and $_.end -eq '20:30'}).Count -eq 1) ($Context+' works overtime before going home to train: '+$Weekday)
  }
  $sleep=@($Blocks|Where-Object {$_.kind -eq 'fixed' -and (($_.start -eq '00:00' -and $_.end -eq '08:00') -or ($_.start -eq '23:00' -and $_.end -eq '24:00'))})
  Assert-That ($sleep.Count -eq 2 -and (($sleep|ForEach-Object {(Sw-Minute $_.end)-(Sw-Minute $_.start)}|Measure-Object -Sum).Sum -eq 540) -and @($Blocks|Where-Object {$_.kind -eq 'fixed' -and $_.start -eq '22:00' -and $_.end -eq '23:00'}).Count -eq 1) ($Context+' preserves nine hours of sleep and one hour to prepare: '+$Weekday)
  $ordered=@($Blocks|Sort-Object start)
  for($index=1;$index -lt $ordered.Count;$index++){Assert-That ((Sw-Minute $ordered[$index-1].end) -le (Sw-Minute $ordered[$index].start)) ($Context+' has no overlapping blocks: '+$Weekday+'/'+$index)}
}
function Sw-Timeline {
  Sz-Seed 'sunshine';$before=Wz-Snapshot
  $p=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate'
  $day=([datetime]::ParseExact($sunSources.sunshine.date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)).DayOfWeek.value__
  Sw-CheckBlocks $p.blocks $day 'Rendered current-day version-four timeline'
  $boxes=Ux-Measure 'swim-overtime-timeline' @('.today','.timeline','.timeline-row','.block-card','.block-title','.time-column')
  Ux-Shot 'swim-overtime-today' '.today';Ux-Shot 'swim-overtime-evening' '.category-overtime'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Viewing the corrected timeline never changes saved execution facts'
}
function Sz-FivePages {
  Sz-Seed 'sunshine';$before=Wz-Snapshot
  Sz-Page 'sunshine-plans' '.plans' @('.create-schedule','.plan-tools-toggle')
  $p=Ux-Go 'pages/today/index' '.today-jump' 'selectedDate'
  Assert-That (@($p.blocks|Where-Object {$_.id -eq 'sleep-morning' -and $_.start -eq '00:00' -and $_.end -eq '08:00'}).Count -eq 1 -and @($p.blocks|Where-Object {$_.id -eq 'sleep' -and $_.start -eq '23:00' -and $_.end -eq '24:00'}).Count -eq 1) 'The actual today page displays both exact midnight sleep segments'
  Sz-Page 'sunshine-today' '.today' @('.today-jump','.rest-day-open')
  $null=Ux-Go 'pages/stats/index' '.overview' 'weeklyTotal';Sz-Page 'sunshine-stats' '.stats' @('.previous-week','.current-week','.next-week','.history-apply')
  $null=Ux-Go 'pages/profile/index' '.settings-group' 'expandedSection'
  Tap ".profile-section[data-section='reminders']";Sz-Page 'sunshine-profile' '.profile' @('.profile-section','.time-setting','.sleep-reminder','.task-reminder')
  $null=Invoke-Ide 'automation_navigate' @('--action','navigateTo','--url',('/pages/training/index?date='+$sunSources.sunshine.date+'&blockId=training')) -ProjectTool
  $p=Wait-UxPage 'pages/training/index' '.execution-controls' 'actions';Assert-That ($p.actions.Count -gt 0) 'The actual training page renders the new reserved-window steps'
  Sz-Page 'sunshine-training' '.training' @('.execution-controls .button-primary','.phase-picker')
  Ux-Shot 'sunshine-training-actions' '.exercise'
  Wz-Equal $before (Wz-Snapshot) @('plan','versions','records','history') 'Navigating and expanding all five pages never edits saved execution facts'
}
Save-State;$exitCode=0
try{
  $status=Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
  if($null -eq $status -or $status.versionRelation -notin @('equal','agent_ahead') -or $status.loginExpired -ne $false){throw 'DevTools version/login gate failed.'}
  if($status.cliTokenRequired -or $status.tokenRequired){$script:Token=$env:DAYFLOW_WECHAT_CLI_TOKEN;if(-not $script:Token){throw 'CLI token required; no credential files were read.'}}
  if($Mode -eq 'Poll'){
    if(-not $script:Pending){throw 'This run has no pending task.'}
    $terminal=Find-Object (Invoke-Ide 'polling_task_result' @('--task-id',$script:State.pendingTask.taskId)) 'status'
    if($null -eq $terminal -or $terminal.status -notin @('success','failed','cancelled','expired')){throw 'Unknown task state; do not replay or restore.'}
    $script:Pending=$false;$script:State.pendingTask.status=$terminal.status;$script:State.outcome='paused-'+$terminal.status
    if($terminal.status -ne 'success'){$exitCode=1}
  }else{
    if($script:Pending){throw 'Resolve the original pending task before restoring.'}
    $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
    if($Mode -eq 'Restore'){Wz-RestoreInterface;$script:State.outcome='restored'}else{
      $snapshot=Evaluate ($sources.backup -replace '\r?\n',' ') @($sources.keys);Save-Json $snapshot (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -PreserveValues
      $script:State.restoreNeeded=$true;Save-State;$manifest=Wz-Manifest;Save-Json $manifest (Join-Path $script:RunDirectory 'source-manifest.json')
      $pages=if($Mode -in @('Sunshine','SwimOvertime')){@('plans','today','training','stats','profile')}else{@('plans','today','training')}
      foreach($page in $pages){foreach($suffix in @('wxml','wxss')){$null=Invoke-Ide ('compile_'+$suffix) @('--file-path',("pages/$page/index.$suffix")) -ProjectTool}}
      if($Mode -eq 'SwimOvertime'){
        Sz-TemplatePreview;Sz-EveningAdoption;Sw-Timeline
      }elseif($Mode -eq 'Sunshine'){
        Sz-RepeatBoundary;Sz-TemplatePreview;Sz-EveningAdoption;Sz-FivePages
        if($Label -eq 'default'){Wz-Overwrite}
        Wz-Rest
      }else{
        Wz-Basic
        if($Mode -eq 'Validate'){Wz-Existing;Wz-RejectedFinalSave 'version';Wz-RejectedFinalSave 'locked';Wz-Identity;Wz-Overwrite;Wz-ExternalFull}
        Wz-NoGap;Wz-Rest
      }
      Save-Json (Invoke-Ide 'get_simulator_console' @('--command','grep -n .') -ProjectTool) (Join-Path $script:RunDirectory 'console-all.local.json')
      Assert-That ((ConvertTo-Json $manifest -Compress) -eq (ConvertTo-Json (Wz-Manifest) -Compress)) 'Business source files stayed frozen throughout simulator acceptance'
      $script:State.outcome='interaction-pass-visual-review-required';$script:State.simulatorInteractionVerified=$true
    }
  }
}catch{$exitCode=1;if(-not $script:Pending){$script:State.outcome='failed'};$message=$_.Exception.Message;if($script:Token){$message=$message.Replace($script:Token,'[REDACTED]')};$script:State.error=$message;Write-Warning $message}
finally{
  if($Mode -in @('Validate','Layout','Sunshine','SwimOvertime') -and $script:State.restoreNeeded -and -not $script:Pending){
    try{Wz-RestoreInterface}catch{$exitCode=1;$script:State.outcome='restoration-required';$script:State.restoreNeeded=$true;$script:State.error=$_.Exception.Message;Write-Warning 'Keep the original backup and use Restore before another test.'}
  }
  $script:State.finished=(Get-Date).ToString('o');Save-State;Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
