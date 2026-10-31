#requires -Version 7.3
[CmdletBinding()]
param([string]$Project=(Split-Path $PSScriptRoot -Parent),[string]$WechatIde='E:\Software\微信web开发者工具\wechatide.cmd')
$ErrorActionPreference='Stop';$PSNativeCommandUseErrorActionPreference=$false
$script:Project=(Resolve-Path -LiteralPath $Project).Path;$script:Token=$env:DAYFLOW_WECHAT_CLI_TOKEN;$script:Pending=$false;$script:Sequence=0
foreach($file in @('wechat-smoke.ps1','wechat-iteration.ps1')){
  $errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$null,[ref]$errors)
  if($errors.Count){throw 'QA helper syntax error.'}
  foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
}
$root=Join-Path $script:Project 'artifacts/wechat-iteration';$activeFile=Join-Path $root 'active-run.json'
if(Test-Path $activeFile){$old=Get-Content $activeFile -Raw|ConvertFrom-Json;if($old.pending -or $old.restoreNeeded){throw 'Complete previous recovery before photo diagnostic.'}}
$script:RunDirectory=Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-photo');New-Item -ItemType Directory -Path $script:RunDirectory -Force|Out-Null
$script:State=@{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';restoreNeeded=$false;assertions=@();pendingTask=$null;mocked=@();realDeviceVerified=$false}
$sources=(& node (Join-Path $PSScriptRoot 'acceptance-fixtures.js')|Out-String)|ConvertFrom-Json -AsHashtable
$exitCode=0;Save-State
try{
  $status=Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
  if($null -eq $status -or $status.loginExpired -ne $false -or $status.versionRelation -notin @('equal','agent_ahead')){throw 'DevTools gate failed.'}
  $null=Invoke-Ide 'open_project_window' @('--window-mode','fullMode') -ProjectTool
  $snapshot=Evaluate ($sources.backup -replace '\r?\n',' ') @($sources.keys);Save-Json $snapshot (Join-Path $script:RunDirectory 'all-dayflow-backup.json') -PreserveValues
  $script:State.restoreNeeded=$true;Save-State;$null=Evaluate ($sources.seed -replace '\r?\n',' ')
  $date=(Get-Date).ToString('yyyy-MM-dd');$null=Invoke-Ide 'simulator_open_page' @('--page','pages/training/index','--query',('date='+$date)) -ProjectTool
  Wait-Page 'pages/training/index';$page=Get-Page '.choose-photo';$id=$page.actions[0].id
  $source="function(){var path=wx.env.USER_DATA_PATH+'/dayflow-qa-synthetic.png';wx.getFileSystemManager().writeFileSync(path,'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');return new Promise(function(resolve){wx.compressImage({src:path,quality:80,success:function(r){resolve({dayflowSmoke:true,source:path,temp:r.tempFilePath,compressed:true});},fail:function(e){resolve({dayflowSmoke:true,source:path,compressed:false,error:e.errMsg});}});});}"
  $source=$source.Replace('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',$sources.png)
  $image=Evaluate $source;Save-Json $image (Join-Path $script:RunDirectory 'compression-result.local.json') -PreserveValues
  if(-not $image.compressed -or -not $image.temp -or $image.temp -eq $image.source){$script:State.outcome='photo-unverified-no-real-temp-file';$script:State.photoError=$image.error}
  else{
    $null=Evaluate "function(){var a=getApp();a.__qaPhotoToasts=[];a.__qaPhotoSaves=[];a.__qaPhotoToast=wx.showToast;a.__qaPhotoFS=wx.getFileSystemManager;wx.showToast=function(o){a.__qaPhotoToasts.push(o.title);};wx.getFileSystemManager=function(){var f=a.__qaPhotoFS.call(wx);return {saveFile:function(o){f.saveFile({tempFilePath:o.tempFilePath,success:function(r){a.__qaPhotoSaves.push({ok:true,path:r.savedFilePath});o.success(r);},fail:function(e){a.__qaPhotoSaves.push({ok:false,error:e.errMsg});o.fail(e);}});},removeSavedFile:f.removeSavedFile.bind(f)};};return {dayflowSmoke:true,hooked:true};}"
    Mock-Api 'requirePrivacyAuthorize' @{errMsg='requirePrivacyAuthorize:ok'}
    Mock-Api 'chooseMedia' @{errMsg='chooseMedia:ok';tempFiles=@(@{tempFilePath=$image.temp;size=68;fileType='image'});type='image'}
    Tap ".choose-photo[data-id='$id']"
    $page=Get-Page '.exercise'
    $result=Evaluate "function(){var p=getCurrentPages().slice(-1)[0],a=getApp();return {dayflowSmoke:true,photoCount:p.data.actions[0].photos.length,toasts:a.__qaPhotoToasts,saves:a.__qaPhotoSaves,metadataCount:(wx.getStorageSync('dayflow.media.v1')||[]).length};}"
    Save-Json $result (Join-Path $script:RunDirectory 'photo-result.local.json') -PreserveValues
    $script:State.photoCount=$result.photoCount;$script:State.metadataCount=$result.metadataCount;$script:State.photoToasts=$result.toasts
    $script:State.outcome=if($result.photoCount -gt 0){'photo-diagnostic-success'}else{'photo-diagnostic-no-image'}
    if($result.photoCount -gt 0){Screenshot 'synthetic-photo' '.record-photo'}
  }
}catch{$exitCode=1;$script:State.error=$_.Exception.Message;if(-not $script:Pending){$script:State.outcome='failed'};Write-Warning $_.Exception.Message}
finally{
  if(-not $script:Pending){
  $failed=$false
  try{$null=Evaluate "function(){var a=getApp();if(a.__qaPhotoToast)wx.showToast=a.__qaPhotoToast;if(a.__qaPhotoFS)wx.getFileSystemManager=a.__qaPhotoFS;var f=wx.getFileSystemManager(),paths=(a.__qaPhotoSaves||[]).filter(function(x){return x.ok;}).map(function(x){return x.path;});return Promise.all(paths.map(function(path){return new Promise(function(resolve){f.removeSavedFile({filePath:path,success:resolve,fail:resolve});});})).then(function(){try{f.unlinkSync(wx.env.USER_DATA_PATH+'/dayflow-qa-synthetic.png');}catch(e){}delete a.__qaPhotoToast;delete a.__qaPhotoFS;delete a.__qaPhotoToasts;delete a.__qaPhotoSaves;return {dayflowSmoke:true,restored:true};});}"}catch{$failed=$true}
  try{Restore-Apis}catch{$failed=$true}
  if($script:State.restoreNeeded){try{Restore-All}catch{$failed=$true}}
  if($failed){$exitCode=1;$script:State.restoreNeeded=$true;$script:State.outcome='restoration-required'}
  }
  $script:State.finished=(Get-Date).ToString('o');Save-State;Write-Host "Result: $($script:State.outcome). Evidence: $script:RunDirectory"
}
exit $exitCode
