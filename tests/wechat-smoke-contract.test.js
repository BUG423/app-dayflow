const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });

test('微信验证脚本真实函数契约：失败关闭、pending 不重放、令牌脱敏及精确恢复', {
  skip: pwsh.error ? 'PowerShell 7 is unavailable; no CLI contract check ran' : false,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-cli-contract-'));
  try {
    const fixturePath = path.join(directory, 'contract.ps1');
    const sourcePath = path.resolve(__dirname, '../scripts/wechat-smoke.ps1');
    // Load function definitions from the real script AST only. Never execute its
    // entry point, and replace the native CLI call with an in-process fixture.
    const fixture = String.raw`
param([string]$SourcePath, [string]$TestDirectory)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PowerShell syntax errors' }
$functions = $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($definition in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
$script:RunDirectory = $TestDirectory
$activeFile = Join-Path $TestDirectory 'active-run.json'
$script:Project = $TestDirectory
$script:Token = 'fixture-token-never-real'
$script:Sequence = 0
$script:Pending = $false
$script:State = @{ restoreNeeded = $false; assertions = @(); pendingTask = $null; outcome = 'running' }
$WechatIde = 'Fake-Ide'
$script:Calls = 0
$script:FixtureExit = 0
$script:LastArgs = @()
function Fake-Ide {
  $script:Calls++
  $script:LastArgs = @($args)
  $global:LASTEXITCODE = $script:FixtureExit
  if ($script:FixtureDiagnostic) {
    Write-Output ([Management.Automation.ErrorRecord]::new([Exception]::new($script:FixtureDiagnostic), 'NativeDiagnostic', [Management.Automation.ErrorCategory]::NotSpecified, $null))
  }
  Write-Output $script:FixtureRaw
}
function Check([bool]$Value, [string]$Name) { if (-not $Value) { throw "Contract failed: $Name" } }
function Must-Throw([scriptblock]$Action, [string]$Name) {
  $threw = $false
  try { & $Action | Out-Null } catch { $threw = $true }
  Check $threw $Name
}

# Logs redact token strings; exact local record backups and restore arguments do not.
$sensitiveRecord = @{ dayflowSmoke = $true; present = $true; value = @{ '2026-10-31' = @{ note = $script:Token; 'music-guitar' = 'done' } } }
$backupPath = Join-Path $TestDirectory 'records-backup.json'
Save-Json $sensitiveRecord $backupPath -PreserveValues
Check ((Get-Content -Raw $backupPath).Contains($script:Token)) 'backup retains exact values'
$redactedPath = Join-Path $TestDirectory 'redacted.json'
Save-Json @{ value = $script:Token } $redactedPath
Check (-not (Get-Content -Raw $redactedPath).Contains($script:Token)) 'ordinary logs redact token'

$script:FixtureRaw = '{"ok":true,"result":{"success":true,"data":{"selectedDate":"2026-10-31","blocks":[]},"diagnostic":"fixture-token-never-real"}}'
$script:FixtureDiagnostic = '[wechatide] skill-call: fixture-token-never-real'
$result = Invoke-Ide 'automation_page_action' @('--action', 'getData') -ProjectTool
Check ((Find-Object $result 'selectedDate').selectedDate -eq '2026-10-31') 'nested page payload'
Check ($result.diagnostic -eq $script:Token) 'parsed payload retains exact values before log redaction'
Check ($script:LastArgs -contains '--token') 'CLI token supplied from environment-backed variable'
$latestLog = Get-Content -Raw (Join-Path $TestDirectory '001-automation_page_action.log')
Check (-not $latestLog.Contains($script:Token)) 'native output redacted before saving'
Check ($latestLog.Contains('[wechatide] skill-call:')) 'stderr diagnostic retained without breaking JSON parsing'
$script:FixtureDiagnostic = $null

$script:FixtureExit = 1
$script:FixtureRaw = '{"ok":false,"message":"fixture failure"}'
Must-Throw { Invoke-Ide 'compile_wxml' } 'native nonzero fails'
$script:FixtureExit = 0
$script:FixtureRaw = '{"ok":true,"result":{"success":false}}'
Must-Throw { Invoke-Ide 'compile_wxml' } 'business failure fails'
$script:FixtureRaw = 'not JSON'
Must-Throw { Invoke-Ide 'compile_wxml' } 'unknown output fails'

$script:FixtureRaw = '{"ok":true,"result":{"success":true,"status":"pending","taskId":"fixture-task"}}'
$beforeCalls = $script:Calls
Must-Throw { Invoke-Ide 'automation_element_action' @('--selector', '.check', '--action', 'tap') } 'pending pauses'
Check ($script:Pending -and $script:State.pendingTask.taskId -eq 'fixture-task') 'pending saved'
Check ($script:Calls -eq $beforeCalls + 1) 'no pending retry'
Must-Throw { Invoke-Ide 'polling_task_result' @('--task-id', 'fixture-task') } 'pending poll pauses'
Check ($script:State.pendingTask.tool -eq 'automation_element_action') 'poll preserves original tool'
Check ($script:State.pendingTask.arguments -contains '.check') 'poll preserves original arguments'

# Native failure envelopes may carry terminal task status under detail.rawResult.
$script:FixtureExit = 1
$script:FixtureRaw = '{"ok":false,"detail":{"rawResult":{"status":"cancelled","taskId":"fixture-task"}}}'
$terminal = Invoke-Ide 'polling_task_result' @('--task-id', 'fixture-task')
Check ($terminal.status -eq 'cancelled') 'terminal cancellation can be resolved without replay'

$script:Pending = $false
$script:FixtureExit = 0
$script:State.restoreNeeded = $true
$script:FixtureRaw = '{"ok":true,"result":{"dayflowSmoke":true,"equal":true}}'
Restore-Records
Check (-not $script:State.restoreNeeded) 'restore readback confirmed'
$argsIndex = [Array]::IndexOf($script:LastArgs, '--args-file')
$restoreArgs = Get-Content -Raw $script:LastArgs[$argsIndex + 1] | ConvertFrom-Json -AsHashtable -NoEnumerate
Check ($restoreArgs[0].value['2026-10-31'].note -eq $script:Token) 'restore arguments retain exact records'
$sourceIndex = [Array]::IndexOf($script:LastArgs, '--fn-source')
Check ($script:LastArgs[$sourceIndex + 1] -notmatch 'removeStorage|clearStorage') 'restore never clears or removes storage'

$script:State.restoreNeeded = $true
$script:FixtureRaw = '{"ok":true,"result":{"dayflowSmoke":true,"equal":false}}'
Must-Throw { Restore-Records } 'readback mismatch fails'
Check $script:State.restoreNeeded 'failed restore retains recovery requirement'

$script:FixtureRaw = '{"ok":true,"result":{"unexpected":true}}'
Must-Throw { Get-Page '.weekday' } 'unknown page payload fails'

# Navigation waits must bind to the new page, never poll the old page forever.
$script:FixtureRaw = '{"ok":true,"result":{"success":true,"currentPage":{"path":"pages/training/index"}}}'
$beforeCalls = $script:Calls
Wait-Page 'pages/training/index'
Check ($script:Calls -eq $beforeCalls + 1) 'ready page stack observed once'
$beforeCalls = $script:Calls
Must-Throw { Wait-Page 'pages/today/index' } 'unready page stack fails'
Check ($script:Calls -eq $beforeCalls + 5) 'page stack observation is bounded'
$script:FixtureRaw = '{"ok":false,"errorType":"MCP_TOOL_ERROR","message":"timeout waiting for automator response"}'
$beforeCalls = $script:Calls
Must-Throw { Wait-Page 'pages/today/index' } 'bridge unavailable fails after bounded reads'
Check ($script:Calls -eq $beforeCalls + 5) 'only known read-only bridge timeout is retried'
$script:FixtureRaw = '{"ok":false,"errorType":"AUTH_DENIED","message":"denied"}'
$beforeCalls = $script:Calls
Must-Throw { Wait-Page 'pages/today/index' } 'authorization failure stops immediately'
Check ($script:Calls -eq $beforeCalls + 1) 'authorization is never retried'
Write-Output 'DAYFLOW_CONTRACT_OK'
`;
    fs.writeFileSync(fixturePath, fixture, 'utf8');
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixturePath, sourcePath, directory], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /DAYFLOW_CONTRACT_OK/);
  } finally {
    const resolvedDirectory = path.resolve(directory);
    const resolvedTemp = path.resolve(os.tmpdir());
    assert.ok(resolvedDirectory.startsWith(resolvedTemp + path.sep), 'Cleanup must stay within the temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
