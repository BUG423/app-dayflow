const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('Windows 原生参数数组完整保留命令元字符，且不通过命令解释器执行', {
  skip: process.platform !== 'win32' ? 'Windows-only native argument regression' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-native-argv-'));
  try {
    const sentinel = path.join(directory, 'must-not-exist.txt');
    const values = [
      '/pages/training/index?date=2026-02-30&blockId=training',
      '--token', 'synthetic-token&%PATH%!^|<>"中文',
      'two words', 'quote"inside', '%PATH%', '!variable!', 'pipe|redirect>input<',
      '^caret', '中文参数', '', 'trailing\\', 'line one\nline two',
      `& echo unsafe > "${sentinel}"`, '$(Write-Output unsafe)',
    ];
    fs.writeFileSync(path.join(directory, 'arguments.json'), JSON.stringify(values));
    fs.writeFileSync(path.join(directory, 'echo.js'), "process.stdout.write(JSON.stringify({args:process.argv.slice(2),env:process.env.DAYFLOW_ARGV_FIXTURE}));process.stderr.write('synthetic diagnostic');process.exitCode=7;");
    const script = String.raw`
param([string]$SourcePath,[string]$Directory,[string]$NodeExecutable)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$null,[ref]$parseErrors)
if($parseErrors.Count){throw 'Helper syntax error'}
foreach($fn in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
$values=Get-Content (Join-Path $Directory 'arguments.json') -Raw -Encoding utf8|ConvertFrom-Json -NoEnumerate
$before=$env:DAYFLOW_ARGV_FIXTURE
$result=Invoke-NativeArgumentProcess $NodeExecutable (@((Join-Path $Directory 'echo.js'))+@($values)) $Directory @{DAYFLOW_ARGV_FIXTURE='合成环境值'}
if($env:DAYFLOW_ARGV_FIXTURE -cne $before){throw 'Parent process environment changed'}
$fake=Join-Path $Directory 'wechatide.cmd'
[IO.File]::WriteAllText($fake,'@echo off')
$rejected=$false
try{Invoke-InstalledWechatCli $fake @('check_wechatide_status')|Out-Null}catch{$rejected=$_.Exception.Message -like '*bootstrap changed*'}
if(-not $rejected){throw 'Unrecognized wrapper did not fail closed'}
$result|ConvertTo-Json -Depth 10 -Compress
`;
    const scriptPath = path.join(directory, 'fixture.ps1');
    fs.writeFileSync(scriptPath, script, 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath, path.resolve(__dirname, '../scripts/wechat-smoke.ps1'), directory, process.execPath], {encoding:'utf8',timeout:30000});
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    const response = JSON.parse(result.stdout);
    assert.equal(response.exitCode, 7);
    assert.equal(response.stderr, 'synthetic diagnostic');
    assert.deepEqual(JSON.parse(response.stdout), {args:values,env:'合成环境值'});
    assert.equal(fs.existsSync(sentinel), false);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, {recursive:true,force:true});
  }
});
