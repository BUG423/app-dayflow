const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('向导入口在CP936宿主自行解码中文、只用列事件选合法分钟且脚本可解析', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-wizard-qa-'));
  try {
    const fixture = String.raw`
param([string]$Source,[string]$Fixture)
$ErrorActionPreference='Stop'
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Wizard entry syntax error'}
foreach($name in @('Initialize-WizardEncoding','Wz-Time','Wz-Equal')){
  $fn=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)[0]
  if($null -eq $fn){throw ('Missing function '+$name)}
  . ([scriptblock]::Create($fn.Extent.Text))
}
[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(936);$OutputEncoding=[Console]::OutputEncoding
Initialize-WizardEncoding
$first=(& node $Fixture '2026-10-31'|Out-String)|ConvertFrom-Json -AsHashtable
$second=(& node $Fixture '2026-10-31'|Out-String)|ConvertFrom-Json -AsHashtable
foreach($value in @($first,$second)){
  if($value.basic.values['dayflow.plans.v1'].schedules[0].title -ne '上午工作'){throw 'Chinese fixture corruption'}
  if($value.basic.values['dayflow.plans.v1'].schedules[3].title -ne '两个月后会议'){throw 'Future fixture corruption'}
  if($value.full.values['dayflow.plans.v1'].schedules[0].blocks[0].end -ne '24:00'){throw 'Full day fixture corruption'}
}
if([Console]::OutputEncoding.CodePage -ne 65001){throw 'Native stdout not UTF8'}
$script:Events=@();$script:Data=@{start='06:00';startTimeRange=@(@('06','12'),@('00'));startTimeIndices=@(0,0)}
function Wz-Data{return $script:Data}
function Assert-That([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Ux-Trigger([string]$Selector,[string]$Type,$Detail){
  if($Selector -ne '.start-time-picker'){throw 'Wrong picker'}
  $script:Events+=@{type=$Type;detail=$Detail}
  if($Type -eq 'columnchange'){
    if($Detail.column -ne 0 -or $Detail.value -ne 1){throw 'Wrong hour column'}
    $script:Data.startTimeRange=@(@('06','12'),@('00','30'))
  }elseif($Type -eq 'change'){
    if($Detail.value.Count -ne 2 -or $Detail.value[0] -ne 1 -or $Detail.value[1] -ne 1){throw 'Picker indices flattened or guessed'}
    $script:Data.start='12:30'
  }else{throw 'Unexpected event'}
}
$p=Wz-Time 'start' '12:30'
if($p.start -ne '12:30' -or $script:Events.Count -ne 2){throw 'Valid picker events missing'}
$before=$script:Events.Count;$failed=$false
try{Wz-Time 'start' '08:00'}catch{$failed=$true}
if(-not $failed -or $script:Events.Count -ne $before){throw 'Busy hour dispatched a mutation'}
$failed=$false;try{Wz-Time 'start' '12:45'}catch{$failed=$true}
if(-not $failed -or @($script:Events|Where-Object type -eq 'change').Count -ne 1){throw 'Unavailable minute dispatched final change'}
$failed=$false;try{Wz-Time 'unknown' '12:30'}catch{$failed=$true}
if(-not $failed){throw 'Invalid picker accepted'}
Wz-Equal @{plan='计划';history='历史'} @{plan='计划';history='历史'} @('plan','history') 'same'
$failed=$false;try{Wz-Equal @{history='历史'} @{history='改写'} @('history') 'different'}catch{$failed=$true}
if(-not $failed){throw 'Historical mismatch accepted'}
Write-Output 'WIZARD_QA_CONTRACT_OK'
`;
    const script = path.join(directory, 'fixture.ps1'); fs.writeFileSync(script, fixture, 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', script,
      path.resolve(__dirname, '../scripts/wechat-planning-wizard.ps1'), path.resolve(__dirname, '../scripts/wizard-acceptance-fixtures.js')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /WIZARD_QA_CONTRACT_OK/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
