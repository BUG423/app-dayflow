const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('布局验收等待同一可见页面实例稳定，仅重试已知只读重载错误',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dayflow-visual-wait-'));
  try{
    const fixture=String.raw`
param([string]$Source)
$ErrorActionPreference='Stop'
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Visual helper parse error'}
$definition=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-VisualToday'},$false)[0]
. ([scriptblock]::Create($definition.Extent.Text))
function Find-Object($Value,$RequiredKey){return $Value}
function Assert-That($Condition,$Message){if(-not $Condition){throw 'Unexpected assertion'};$script:Ready++}
function Invoke-Ide($Tool,$Arguments,[switch]$ProjectTool){
  if($Tool -ne 'automation_runtime_info'){throw 'Unexpected mutation'}
  $id=$script:Ids[$script:Reads];$script:Reads++
  return @{currentPage=@{pageId=$id;path='pages/today/index'}}
}
function Get-Page($Selector){
  $script:Views++
  if($script:ThrowView){$script:ThrowView=$false;$e=[InvalidOperationException]::new('read fixture');$e.Data['ToolErrorType']=$script:ErrorType;$e.Data['ToolMessage']=$script:ErrorMessage;throw $e}
  return @{selectedDate='2026-10-31'}
}
function Reset { $script:Reads=0;$script:Views=0;$script:Ready=0;$script:ThrowView=$false }
Reset;$script:Ids=@(1,2,2,2,2,2);Wait-VisualToday
if($script:Reads -ne 6 -or $script:Ready -ne 1){throw 'A changed page instance was accepted too early'}
Reset;$script:Ids=@(1,2,2,2,2);$script:ThrowView=$true;$script:ErrorType='MCP_TOOL_ERROR';$script:ErrorMessage='waitForSelector timeout: .today-jump: page is not on top of page stack';Wait-VisualToday
if($script:Reads -ne 5 -or $script:Ready -ne 1){throw 'Known read-only reload did not reacquire a stable page'}
Reset;$script:Ids=@(1);$script:ThrowView=$true;$script:ErrorType='AUTH_DENIED';$script:ErrorMessage='denied';$threw=$false
try{Wait-VisualToday}catch{$threw=$true}
if(-not $threw -or $script:Reads -ne 1){throw 'Authorization error was retried'}
Reset;$script:Ids=@(1,2,3,4,5,6,7,8,9,10);$threw=$false
try{Wait-VisualToday}catch{$threw=$true}
if(-not $threw -or $script:Reads -ne 10 -or $script:Ready){throw 'Unstable page did not stop at bounded reads'}
Write-Output 'VISUAL_WAIT_OK'
`;
    const script=path.join(directory,'fixture.ps1');fs.writeFileSync(script,fixture,'utf8');
    const result=spawnSync('pwsh',['-NoProfile','-File',script,path.resolve(__dirname,'../scripts/wechat-visual.ps1')],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,`${result.error||''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout,/VISUAL_WAIT_OK/);
  }finally{
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
