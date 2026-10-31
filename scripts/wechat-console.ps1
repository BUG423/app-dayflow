#requires -Version 7.3
[CmdletBinding()]
param([string]$Project=(Split-Path $PSScriptRoot -Parent),[string]$WechatIde='E:\Software\微信web开发者工具\wechatide.cmd')
$ErrorActionPreference='Stop'
$script:Project=(Resolve-Path -LiteralPath $Project).Path
$script:Token=$env:DAYFLOW_WECHAT_CLI_TOKEN
$script:Sequence=0
$script:Pending=$false
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'wechat-smoke.ps1'),[ref]$null,[ref]$parseErrors)
if($parseErrors.Count){throw 'CLI helper syntax error.'}
foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
foreach($kind in @('wechat-iteration','wechat-visual')){
  $marker=Join-Path $script:Project "artifacts/$kind/active-run.json"
  if(Test-Path $marker){$active=Get-Content $marker -Raw|ConvertFrom-Json;if($active.pending -or $active.restoreNeeded){throw 'Finish the active validation and restore storage before collecting final console evidence.'}}
}
$root=Join-Path $script:Project 'artifacts/wechat-console'
New-Item -ItemType Directory -Path $root -Force|Out-Null
$activeFile=Join-Path $root 'active-run.json'
$script:RunDirectory=Join-Path $root (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $script:RunDirectory -Force|Out-Null
$script:State=@{project=$script:Project;started=(Get-Date).ToString('o');outcome='running';restoreNeeded=$false;assertions=@();pendingTask=$null;realDeviceVerified=$false}
Save-State
$exitCode=0
try{
  $status=Find-Object (Invoke-Ide 'check_wechatide_status' @('--skill-version','0.3.11')) 'versionRelation'
  if($null -eq $status -or $status.versionRelation -notin @('equal','agent_ahead') -or $status.loginExpired -ne $false){throw 'DevTools version/login gate failed.'}
  if(($status.cliTokenRequired -or $status.tokenRequired) -and -not $script:Token){throw 'CLI token required; no credentials were read.'}
  $console=Invoke-Ide 'get_simulator_console' @('--command','grep -n .') -ProjectTool
  Save-Json $console (Join-Path $script:RunDirectory 'console-all.local.json')
  $script:State.outcome='console-evidence-collected'
}catch{
  $exitCode=1
  $script:State.outcome='failed'
  $script:State.error=$_.Exception.Message
  Write-Warning $_.Exception.Message
}finally{
  $script:State.finished=(Get-Date).ToString('o')
  Save-State
  Write-Host "Result: $($script:State.outcome). Local evidence: $script:RunDirectory"
}
exit $exitCode
