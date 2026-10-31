const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('新版验收只对已知只读重载重试，恢复页失败仍保留待恢复标记',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dayflow-ux-qa-'));
  try{
    const fixture=String.raw`
param([string]$Source)
$ErrorActionPreference='Stop'
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$errors)
if($errors.Count){throw 'UX helper parse error'}
foreach($name in @('Wait-UxPage','Ux-RestoreInterface','Ux-Measure','Ux-Expand')){
  $definition=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)[0]
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Find-Object($Value,$RequiredKey){return $Value}
function Invoke-Ide($Tool,$Arguments,[switch]$ProjectTool){
  if($Tool -ne 'automation_runtime_info'){throw 'Unexpected mutation'}
  $id=$script:Ids[$script:Reads];$script:Reads++
  return @{currentPage=@{pageId=$id;path='pages/stats/index'}}
}
function Ux-Page($Selector,$Key){
  if($script:ThrowView){$script:ThrowView=$false;$e=[InvalidOperationException]::new('read fixture');$e.Data['ToolErrorType']=$script:ErrorType;$e.Data['ToolMessage']=$script:ErrorMessage;throw $e}
  return @{weekLabel='2026-10-26 ~ 2026-11-01'}
}
$script:Reads=0;$script:Ids=@(1,2,2,2,2,2);$script:ThrowView=$false
$page=Wait-UxPage 'pages/stats/index' '.week-label' 'weekLabel'
if($script:Reads -ne 6 -or -not $page.weekLabel){throw 'Changed page instance accepted'}
$script:Reads=0;$script:Ids=@(1,2,2,2,2);$script:ThrowView=$true;$script:ErrorType='MCP_TOOL_ERROR';$script:ErrorMessage='waitForSelector timeout: .week-label: page is not on top of page stack'
$page=Wait-UxPage 'pages/stats/index' '.week-label' 'weekLabel'
if($script:Reads -ne 5){throw 'Known read-only page reload not recovered'}
$script:Reads=0;$script:Ids=@(1);$script:ThrowView=$true;$script:ErrorType='AUTH_DENIED';$script:ErrorMessage='denied';$failed=$false
try{Wait-UxPage 'pages/stats/index' '.week-label' 'weekLabel'}catch{$failed=$true}
if(-not $failed -or $script:Reads -ne 1){throw 'Authorization failure retried'}
$script:Reads=0;$script:Ids=@(1,2,3,4,5,6,7,8,9,10);$failed=$false
try{Wait-UxPage 'pages/stats/index' '.week-label' 'weekLabel'}catch{$failed=$true}
if(-not $failed -or $script:Reads -ne 10){throw 'Unstable view did not stop'}
function Evaluate([string]$Source,$Arguments=@()){
  if($Arguments.Count -ne 1 -or $Arguments[0] -isnot [array] -or $Arguments[0].Count -ne 2){throw 'Measurement selector array was flattened into separate arguments'}
  throw 'UX_ARGUMENTS_OK'
}
$argumentResult='';try{Ux-Measure 'test' @('.first','.second')}catch{$argumentResult=$_.Exception.Message}
if($argumentResult -ne 'UX_ARGUMENTS_OK'){throw $argumentResult}
function Ux-Page($Selector,$Key){$script:VisibilityReads++;return @{visible=$script:Visible}}
function Tap($Selector){if($Selector -ne '.toggle'){throw 'Unexpected toggle'};$script:Taps++;$script:Visible=$true}
$script:Visible=$false;$script:Taps=0;$script:VisibilityReads=0
Ux-Expand 'visible' '.toggle' '.anchor';Ux-Expand 'visible' '.toggle' '.anchor'
if($script:Taps -ne 1 -or $script:VisibilityReads -ne 2){throw 'Repeated acceptance closed an already-open panel'}
$script:Visible=$true;$script:Taps=0;Ux-Expand 'visible' '.toggle' '.anchor'
if($script:Taps -ne 0){throw 'Existing visible state was toggled away'}
$script:Visible='false';$failed=$false;try{Ux-Expand 'visible' '.toggle' '.anchor'}catch{$failed=$true}
if(-not $failed -or $script:Taps -ne 0){throw 'Unknown panel visibility caused a click'}
$script:State=@{restoreNeeded=$true};$script:restores=0
function Ux-RestoreAll{$script:restores++}
function Ux-Go($Path,$Selector,$Key){throw 'Restore UI is not ready'}
$failed=$false;try{Ux-RestoreInterface}catch{$failed=$true}
if(-not $failed -or $script:restores -ne 1 -or -not $script:State.restoreNeeded -or $script:State.originalInterfaceRestored){throw 'Incomplete recovery claimed success'}
Write-Output 'UX_QA_CONTRACT_OK'
`;
    const script=path.join(directory,'fixture.ps1');fs.writeFileSync(script,fixture,'utf8');
    const result=spawnSync('pwsh',['-NoProfile','-File',script,path.resolve(__dirname,'../scripts/wechat-ux.ps1')],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,`${result.error||''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout,/UX_QA_CONTRACT_OK/);
  }finally{
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('验收脚本在CP936宿主中自行按UTF8读取Node中文JSON，无需调用者前缀',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dayflow-ux-encoding-'));
  try{
    const fixture=String.raw`
param([string]$Source,[string]$NodeFixture)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(936)
$OutputEncoding=[Console]::OutputEncoding
$corrupt=$false
try{
  $bad=(& node $NodeFixture '2026-10-31'|Out-String)|ConvertFrom-Json -AsHashtable
  $corrupt=$bad.layout.values['dayflow.plans.v1'].schedules[0].title -ne '布局验收安排'
}catch{$corrupt=$true}
if(-not $corrupt){throw 'CP936 reproduction did not expose the original UTF8 decoding mismatch'}
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$errors)
if($errors.Count){throw 'UX script parse failure'}
$definition=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Initialize-UxEncoding'},$false)[0]
. ([scriptblock]::Create($definition.Extent.Text))
Initialize-UxEncoding
$data=(& node $NodeFixture '2026-10-31'|Out-String)|ConvertFrom-Json -AsHashtable
if($data.layout.values['dayflow.plans.v1'].schedules[0].title -ne '布局验收安排'){throw 'Chinese fixture text corrupted'}
if($data.layout.values['dayflow.plans.v1'].schedules[0].blocks[1].title -ne '加班'){throw 'Chinese overtime text corrupted'}
if([Console]::OutputEncoding.CodePage -ne 65001){throw 'Native stdout decoding is not UTF8'}
Write-Output 'UX_ENCODING_OK'
`;
    const script=path.join(directory,'fixture.ps1');fs.writeFileSync(script,fixture,'utf8');
    const result=spawnSync('pwsh',['-NoProfile','-File',script,path.resolve(__dirname,'../scripts/wechat-ux.ps1'),path.resolve(__dirname,'../scripts/ux-acceptance-fixtures.js')],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,`${result.error||''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout,/UX_ENCODING_OK/);
  }finally{
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
