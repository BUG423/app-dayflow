const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const fixtures = require('../scripts/local-backup-acceptance-fixtures');

// Execute only parsed recovery function definitions with in-memory doubles.
// The acceptance entry point and the WeChat CLI are never started here.
function runRecoveryContract(worker) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-backup-recovery-'));
  try {
    const file = path.join(directory, 'contract.ps1');
    fs.writeFileSync(file, worker, 'utf8');
    const entry = path.resolve(__dirname, '../scripts/wechat-local-backup.ps1');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', file, entry], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    assert.match(result.stdout, /LOCAL_BACKUP_RECOVERY_CONTRACT_OK/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('验收恢复在业务已恢复后只清理本轮文件，清理重试不重放旧快照，pending不做任何恢复', () => {
  runRecoveryContract(String.raw`
param([string]$Entry)
$ErrorActionPreference='Stop'
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Entry,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Recovery entry syntax is invalid'}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -like 'Bk-*'},$false)){
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Assert-That([bool]$Condition,[string]$Message){Check $Condition $Message}
function Save-State {$script:SavedStates+=($script:State|ConvertTo-Json -Depth 50 -Compress)}
function Save-Json($Value,[string]$Path,[switch]$PreserveValues){}
function Invoke-Ide([string]$Tool,[string[]]$ToolArguments=@(),[switch]$ProjectTool){
  $script:UnexpectedCalls++
  throw 'A cleanup-only run must not restart the runtime or invoke the WeChat CLI'
}
function Ux-RestoreAll {$script:StorageWrites++;throw 'An old storage snapshot was replayed'}
function Ux-RestoreInterface {$script:StorageWrites++;throw 'An old interface/storage restore was replayed'}
function Bk-Discover {$script:Discoveries++;if($script:FailDiscovery){throw 'A read-only file discovery failed'};return @()}
function Bk-Evaluate([string]$Name,$Arguments=@()){
  if($Name -eq 'cleanupAbsent'){$script:CleanupReads++;return @{dayflowSmoke=$true;absent=$true}}
  if($Name -ne 'cleanupFiles'){throw ('Unexpected recovery evaluate: '+$Name)}
  $script:Cleanups++
  if($script:FailCleanup){$script:Pending=$true;throw 'Synthetic cleanup awaits its original pending task'}
  return @{dayflowSmoke=$true;cleaned=$true}
}
function Reset-Case {
  $script:Pending=$false
  $script:State=@{storageRestored=$true;restoreNeeded=$true;fileCleanupNeeded=$true;harnessInstalled=$false;nonce='0123456789abcdef0123456789abcdef';backupBeforeNames=@('user-backup.json');fileManifest=@()}
  $script:StorageWrites=0;$script:Discoveries=0;$script:Cleanups=0;$script:UnexpectedCalls=0
  $script:FailCleanup=$false;$script:FailDiscovery=$false;$script:CleanupReads=0;$script:SavedStates=@()
  # Represents a real user record made after restoration. No old snapshot may replace it.
  $script:UserRecord='new-user-record-after-restoration'
}
Reset-Case
Bk-Recover
Check ($script:Cleanups -eq 1) 'A cleanup-only recovery did not clean the owned files'
Check ($script:StorageWrites -eq 0 -and $script:UnexpectedCalls -eq 0) 'Cleanup replayed old state'
Check ($script:State.storageRestored -and -not $script:State.fileCleanupNeeded -and -not $script:State.restoreNeeded) 'Cleanup-only recovery did not finish'
Check ($script:UserRecord -eq 'new-user-record-after-restoration') 'A newer user record changed'

Reset-Case
$script:FailDiscovery=$true;$rejected=$false
try{Bk-Recover}catch{$rejected=$true}
Check $rejected 'Interrupted cleanup was claimed successful'
Check ($script:State.storageRestored -and $script:State.restoreNeeded -and $script:State.fileCleanupNeeded) 'Cleanup failure lost the completed storage phase'
$script:FailDiscovery=$false
Bk-Recover
Check ($script:Cleanups -eq 1 -and $script:StorageWrites -eq 0 -and $script:UnexpectedCalls -eq 0) 'Cleanup retry replayed an original snapshot'
Check (-not $script:State.restoreNeeded) 'Cleanup retry did not finish'
Check ($script:UserRecord -eq 'new-user-record-after-restoration') 'Cleanup retry changed a newer record'

Reset-Case
$script:FailCleanup=$true;$rejected=$false
try{Bk-Recover}catch{$rejected=$true}
Check $rejected 'An unknown cleanup response was claimed successful'
$script:FailCleanup=$false
$script:Pending=$false
Bk-Recover
Check ($script:Cleanups -eq 1 -and $script:CleanupReads -eq 1) 'An uncertain cleanup was replayed instead of verified read-only'
Check ($script:StorageWrites -eq 0 -and $script:UnexpectedCalls -eq 0) 'An uncertain cleanup repeated an old storage restore'

Reset-Case
$script:Pending=$true;$rejected=$false
try{Bk-Recover}catch{$rejected=$true}
Check $rejected 'A pending task did not block recovery'
Check ($script:Cleanups -eq 0 -and $script:Discoveries -eq 0 -and $script:StorageWrites -eq 0 -and $script:UnexpectedCalls -eq 0) 'A pending task replayed recovery work'
Write-Output 'LOCAL_BACKUP_RECOVERY_CONTRACT_OK'
`);
});

test('文件清理重试只补录新增清单，不重新接受已知文件的新哈希或丢掉已删除项', () => {
  const root = 'wxfile://usr', directory = root + '/dayflow-backups';
  const nonce = '0123456789abcdef0123456789abcdef';
  const files = new Map();
  const runId = 'local-backup-acceptance-' + nonce;
  const originalName = 'dayflow-records-original.json';
  const newName = 'dayflow-records-added.json';
  const originalText = JSON.stringify({ kind: 'dayflow-local-record-backup', data: { plans: { id: runId } } });
  files.set(directory + '/' + originalName, originalText);
  const manager = {
    readdirSync: () => [...files.keys()].map(name => name.slice(directory.length + 1)),
    readFileSync: name => files.get(name),
  };
  const discover = vm.runInNewContext('(' + fixtures.discoverFiles.toString() + ')', {
    wx: { env: { USER_DATA_PATH: root }, getFileSystemManager: () => manager },
    textHash: fixtures.textHash,
  });
  const first = discover({ nonce, before: [] }).files;
  const firstImage = JSON.stringify(first);
  files.set(directory + '/' + newName, originalText);
  const second = discover({ nonce, before: [], known: first }).files;
  assert.equal(second.length, 2);
  assert.equal(JSON.stringify(first), firstImage, 'discovery must not mutate the recorded ownership baseline');
  files.set(directory + '/' + originalName, originalText + ' ');
  assert.throws(() => discover({ nonce, before: [], known: second }), /already recorded.*changed/);
  assert.equal(JSON.stringify(first), firstImage);
  files.clear();
  const remaining = discover({ nonce, before: [], known: second }).files;
  assert.equal(JSON.stringify(remaining), JSON.stringify(second), 'missing files remain recorded so cleanup can skip them idempotently');
});

test('受控运行时只请求一次刷新，pending或有界探针失败后仅观察而不重复刷新', () => {
  runRecoveryContract(String.raw`
param([string]$Entry)
$ErrorActionPreference='Stop'
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Entry,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Recovery entry syntax is invalid'}
$definition=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Bk-RestartContext'},$false))
if($definition.Count -ne 1){throw 'A unique context restart function is required'}
. ([scriptblock]::Create($definition[0].Extent.Text))
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Assert-That([bool]$Condition,[string]$Message){Check $Condition $Message}
function Save-State {$script:SavedStates+=($script:State|ConvertTo-Json -Depth 30 -Compress)}
function Invoke-Ide([string]$Tool,[string[]]$ToolArguments=@(),[switch]$ProjectTool){
  Check ($Tool -eq 'simulator_refresh') 'Context verification called an unrelated mutating tool'
  Check ($script:State.sdkRefreshRequested -and $script:SavedStates.Count -gt 0) 'The refresh request was not persisted before calling it'
  $script:Refreshes++
  if($script:PauseRefresh){$script:Pending=$true;throw 'The original refresh task is pending'}
  return @{ok=$true}
}
function Bk-Evaluate([string]$Name,$Arguments=@()){
  Check ($Name -eq 'sdkContext') 'Context recovery used function identity or an unrelated operation'
  $script:Probes++
  $ready=$script:Probes -ge $script:ReadyAfter
  return @{dayflowSmoke=$true;appReady=$ready;pageReady=$ready;harnessAbsent=$ready;apisReady=$ready}
}
function Reset-Case {
  $script:Pending=$false;$script:State=@{harnessInstalled=$true;sdkRefreshRequested=$false;sdkContextRestartVerified=$false}
  $script:SavedStates=@();$script:Refreshes=0;$script:Probes=0;$script:ReadyAfter=3;$script:PauseRefresh=$false
}
Reset-Case
Bk-RestartContext
Check ($script:Refreshes -eq 1 -and $script:Probes -eq 3) 'The runtime was refreshed more than once or was not observed until ready'
Check ($script:State.sdkContextRestartVerified -and -not $script:State.harnessInstalled) 'Fresh runtime readiness was not persisted'
Bk-RestartContext
Check ($script:Refreshes -eq 1 -and $script:Probes -eq 3) 'An already verified restart was repeated'

Reset-Case
$script:PauseRefresh=$true;$rejected=$false
try{Bk-RestartContext}catch{$rejected=$true}
Check ($rejected -and $script:Pending -and $script:Refreshes -eq 1 -and $script:Probes -eq 0) 'A pending refresh was replayed or treated as completed'
$script:Pending=$false;$script:PauseRefresh=$false;$script:ReadyAfter=1
Bk-RestartContext
Check ($script:Refreshes -eq 1 -and $script:Probes -eq 1) 'Resuming the original pending refresh issued another refresh'

Reset-Case
$script:ReadyAfter=99;$rejected=$false
try{Bk-RestartContext}catch{$rejected=$true}
Check ($rejected -and $script:Refreshes -eq 1 -and $script:Probes -eq 5) 'Read-only runtime observations were not bounded'
$script:ReadyAfter=6
Bk-RestartContext
Check ($script:Refreshes -eq 1 -and $script:Probes -eq 6) 'Retrying readiness verification repeated the refresh'

Reset-Case
$script:Pending=$true;$rejected=$false
try{Bk-RestartContext}catch{$rejected=$true}
Check ($rejected -and $script:Refreshes -eq 0 -and $script:Probes -eq 0) 'A still-pending task allowed a second context operation'
Write-Output 'LOCAL_BACKUP_RECOVERY_CONTRACT_OK'
`);
});

test('被中断的第二次原值恢复只能只读核对，发现之后的记录变化时不重放旧快照', () => {
  runRecoveryContract(String.raw`
param([string]$Entry)
$ErrorActionPreference='Stop'
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Entry,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Recovery entry syntax is invalid'}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -like 'Bk-*'},$false)){
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Assert-That([bool]$Condition,[string]$Message){Check $Condition $Message}
function Save-State {$script:SavedStates+=($script:State|ConvertTo-Json -Depth 50 -Compress)}
function Save-Json($Value,[string]$Path,[switch]$PreserveValues){}
function Invoke-Ide([string]$Tool,[string[]]$ToolArguments=@(),[switch]$ProjectTool){$script:UnexpectedCalls++;throw 'An interrupted storage stage must not replay navigation or a CLI call'}
function Ux-RestoreAll {$script:StorageWrites++;throw 'The interrupted original snapshot was replayed'}
function Ux-RestoreInterface {$script:StorageWrites++;throw 'The old whole recovery entry was replayed'}
function Bk-VerifyOriginal {
  $script:ReadVerifications++
  if(-not $script:MatchesOriginal){throw 'Newer user data differs from the old snapshot'}
  return $true
}
function Reset-Case {
  $script:Mode='Restore'
  $script:Pending=$false;$script:SavedStates=@()
  $script:State=@{storageRestored=$false;restoreNeeded=$true;fileCleanupNeeded=$true;harnessInstalled=$false;restoreFirstStarted=$true;restoreFirstVerified=$true;restoreUiStarted=$true;restoreUiVerified=$true;restoreSecondStarted=$true;restoreSecondVerified=$false}
  $script:StorageWrites=0;$script:UnexpectedCalls=0;$script:ReadVerifications=0
  $script:MatchesOriginal=$false
  $script:UserRecord='new-record-saved-while-recovery-was-interrupted'
}
Reset-Case
$rejected=$false
try{Bk-RestoreStorage}catch{$rejected=$true}
Check $rejected 'Newer data was silently considered restored'
Check ($script:ReadVerifications -eq 1) 'Interrupted storage was not checked read-only'
Check ($script:StorageWrites -eq 0 -and $script:UnexpectedCalls -eq 0) 'Interrupted storage replayed an old write or navigation'
Check (-not $script:State.storageRestored -and -not $script:State.restoreSecondVerified) 'An unverified restoration was marked complete'
Check ($script:UserRecord -eq 'new-record-saved-while-recovery-was-interrupted') 'The later user record was changed'

Reset-Case
$script:MatchesOriginal=$true
Bk-RestoreStorage
Check ($script:ReadVerifications -ge 1 -and $script:StorageWrites -eq 0 -and $script:UnexpectedCalls -eq 0) 'An already completed storage task was replayed'
Check ($script:State.storageRestored -and $script:State.restoreSecondVerified) 'Read-only verified completion was not persisted'
Check ($script:SavedStates.Count -gt 0) 'Storage completion had no durable checkpoint'
Write-Output 'LOCAL_BACKUP_RECOVERY_CONTRACT_OK'
`);
});

