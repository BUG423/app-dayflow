const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRuntime, clone } = require('./helpers/miniprogram');
const { sunshinePayload } = require('../scripts/sunshine-acceptance-fixtures');

test('泳后加班验收夹具从旧v3自定义计划采用v4，历史来源保持明确', () => {
  const payload = sunshinePayload('2026-11-01', new Date(2026, 10, 1, 8).getTime(), 'custom');
  const run = createRuntime(new Date(2026, 10, 1, 8)), validation = run.load('miniprogram/utils/plan-validation.ts');
  Object.entries(payload.values).forEach(([key, value]) => run.storage.set(key, clone(value)));
  const oldSwim = validation.resolveBlocks(payload.values['dayflow.plans.v1'], '2026-11-03');
  assert.equal(oldSwim.some(block => block.category === '加班'), false, 'the migration starts from the frozen v3 source');
  const plans = run.load('miniprogram/services/plans.ts'), preview = plans.previewEveningRoutineUpdate(4);
  assert.equal(preview.ok, true); plans.saveEveningRoutineUpdate(4, preview.lease);
  const currentSwim = plans.getDayBlocks('2026-11-03');
  assert.ok(currentSwim.some(block => block.category === '加班' && block.start === '19:30' && block.end === '21:30'));
  assert.deepEqual(clone(run.storage.get('dayflow.instances.v1')['2026-11-01']), payload.values['dayflow.instances.v1']['2026-11-01']);
});

test('专用模拟器模式的真实PowerShell顺序断言接受七天新作息并拒绝缺加班、反序、重叠和少睡', () => {
  const root = path.resolve(__dirname, '..'), entry = path.join(root, 'scripts/wechat-planning-wizard.ps1');
  const source = fs.readFileSync(entry, 'utf8');
  assert.match(source, /ValidateSet\('Validate','Layout','Sunshine','SwimOvertime','Restore','Poll'\)/);
  assert.match(source, /if\(\$Mode -eq 'SwimOvertime'\)\{\s*Sz-TemplatePreview;Sz-EveningAdoption;Sw-Timeline/);
  assert.match(source, /if\(\$Mode -in @\('Validate','Layout','Sunshine','SwimOvertime'\) -and \$script:State.restoreNeeded -and -not \$script:Pending\)/);
  assert.match(source, /\$pages=if\(\$Mode -in @\('Sunshine','SwimOvertime'\)\)\{@\('plans','today','training','stats','profile'\)\}/);
  const run = createRuntime(new Date(2026, 10, 1, 8)), plans = run.load('miniprogram/services/plans.ts');
  const days = Array.from({ length: 7 }, (_, index) => ({ weekday: (index + 1) % 7, blocks: clone(plans.getDayBlocks('2026-11-0' + (index + 2))) }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-swim-qa-'));
  try {
    const fixture = path.join(directory, 'fixture.json'); fs.writeFileSync(fixture, JSON.stringify(days));
    const worker = String.raw`
param([string]$Entry,[string]$Fixture)
$ErrorActionPreference='Stop'
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Entry,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Acceptance entry has invalid syntax'}
foreach($name in @('Sw-Minute','Sw-CheckBlocks')){
 $fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false))
 if($fn.Count -ne 1){throw 'Required order assertion is missing or ambiguous'}
 . ([scriptblock]::Create($fn[0].Extent.Text))
}
function Assert-That([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
$days=Get-Content -LiteralPath $Fixture -Raw -Encoding utf8|ConvertFrom-Json -AsHashtable
foreach($day in $days){Sw-CheckBlocks $day.blocks $day.weekday 'Synthetic saved plan'}
$rendered=@($days|Where-Object {$_.weekday -eq 2})[0]
foreach($block in $rendered.blocks){$block.actions=@();$block.Remove('tasks')}
Sw-CheckBlocks $rendered.blocks 2 'Actual page projection'
foreach($damage in @('missing-overtime','wrong-order','overlap','short-sleep')){
 $copy=@(($days|ConvertTo-Json -Depth 60 -Compress|ConvertFrom-Json -AsHashtable)|Where-Object {$_.weekday -eq 2})[0]
 if($damage -eq 'missing-overtime'){$copy.blocks=@($copy.blocks|Where-Object {$_.category -ne '加班'})}
 if($damage -eq 'wrong-order'){@($copy.blocks|Where-Object {$_.category -eq '加班'})[0].start='17:00'}
 if($damage -eq 'overlap'){@($copy.blocks|Where-Object {$_.title -eq '游泳后返回工作地点'})[0].start='18:59'}
 if($damage -eq 'short-sleep'){@($copy.blocks|Where-Object {$_.start -eq '23:00'})[0].end='23:59'}
 $rejected=$false;try{Sw-CheckBlocks $copy.blocks 2 'Deliberately invalid fixture'}catch{$rejected=$true}
 if(-not $rejected){throw ('Invalid timeline was accepted: '+$damage)}
}
Write-Output 'SWIM_OVERTIME_PS_OK'
`;
    const file = path.join(directory, 'worker.ps1'); fs.writeFileSync(file, worker, 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', file, entry, fixture], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    assert.match(result.stdout, /SWIM_OVERTIME_PS_OK/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
