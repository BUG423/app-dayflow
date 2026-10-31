const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sources, fnv, SLOT, MAX_CHUNK } = require('../scripts/acceptance-restore-transport');
const { backup, KNOWN_KEYS } = require('../scripts/acceptance-fixtures');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const nonce = '1234567890abcdef1234567890abcdef';
function runtime(initial = {}) {
  const store = new Map(Object.entries(clone(initial))), app = {}, writes = [];
  const wx = { getStorageInfoSync: () => ({ keys: [...store.keys()] }), getStorageSync: key => clone(store.get(key)),
    setStorageSync: (key, value) => { writes.push(key); store.set(key, clone(value)); }, removeStorageSync: key => { writes.push(key); store.delete(key); } };
  const context = vm.createContext({ getApp: () => app, wx });
  return { app, store, writes, call: (method, args) => {
    const source = sources()[method], bytes = Buffer.byteLength(JSON.stringify({ source, arguments: args }));
    assert.ok(bytes < 65536, 'Every injected request must stay below the capped transport size');
    return vm.runInContext('(' + source + ')', context)(...args);
  }, snapshot: () => vm.runInContext('(' + backup.toString() + ')', context)(KNOWN_KEYS) };
}
function packets(text) {
  const chunks = []; let offset = 0;
  while (offset < text.length) { let size = Math.min(MAX_CHUNK, text.length - offset); if (offset + size < text.length && /[\uD800-\uDBFF]/.test(text[offset + size - 1])) size--; chunks.push(text.slice(offset, offset + size)); offset += size; }
  return chunks.map((text, index) => ({ nonce, index, total: chunks.length, text, chars: text.length, hash: fnv(text) }));
}
function stage(run, text) {
  const chunks = packets(text); run.call('begin', [{ nonce, total: chunks.length, chars: text.length, hash: fnv(text) }]);
  for (const packet of chunks) run.call('part', [packet]);
}

test('大备份在受限传输下分块暂存，finish前零存储写入，原严格restore精确回读', () => {
  const original = { 'dayflow.plans.v1': { note: ('合成备份内容☀️🌈，保留全部文字。').repeat(20000), version: 7 }, 'dayflow.future.v99': { keep: true }, unrelated: { keep: 7 } };
  const run = runtime(original), snapshot = run.snapshot(), text = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(text) > 303878);
  assert.ok(Buffer.byteLength(JSON.stringify({ arguments: [snapshot] })) > 65536, 'The original one-request transport would be rejected');
  run.store.set('dayflow.plans.v1', { synthetic: true }); run.store.set('dayflow.test-key', 1);
  stage(run, text); assert.equal(run.writes.length, 0); assert.ok(run.app[SLOT]);
  const result = run.call('finish', [nonce]); assert.equal(result.equal, true); assert.equal(run.app[SLOT], undefined);
  assert.deepEqual(Object.fromEntries(run.store), original);
  assert.equal(Object.keys(result).some(key => /value|snapshot|text|parts/.test(key)), false, 'Only recovery metadata leaves finish');
});

test('缺块、错序、损坏校验或nonce不匹配拒写，不能清掉另一份私有暂存', () => {
  const text = JSON.stringify({ schemaVersion: 1, initialKeys: [], keys: {} }), parts = packets(text);
  for (const corrupt of [p => ({ ...p, index: 1 }), p => ({ ...p, hash: '00000000' }), p => ({ ...p, nonce: '0'.repeat(32) }), p => ({ ...p, chars: p.chars + 1 })]) {
    const run = runtime({ 'dayflow.keep': 1 }); run.call('begin', [{ nonce, total: parts.length, chars: text.length, hash: fnv(text) }]);
    assert.throws(() => run.call('part', [corrupt(parts[0])])); assert.equal(run.writes.length, 0);
    assert.throws(() => run.call('abort', ['f'.repeat(32)])); assert.ok(run.app[SLOT]);
    assert.equal(run.call('abort', [nonce]).aborted, true); assert.equal(run.app[SLOT], undefined);
  }
  const incomplete = runtime({ 'dayflow.keep': 1 }); incomplete.call('begin', [{ nonce, total: 2, chars: text.length, hash: fnv(text) }]);
  assert.throws(() => incomplete.call('finish', [nonce]), /incomplete/); assert.equal(incomplete.writes.length, 0); assert.equal(incomplete.app[SLOT], undefined);
  const damaged = runtime({ 'dayflow.keep': 1 }); stage(damaged, text); damaged.app[SLOT].hash = '00000000';
  assert.throws(() => damaged.call('finish', [nonce]), /checksum/); assert.equal(damaged.writes.length, 0); assert.equal(damaged.app[SLOT], undefined);
});

test('分块不会绕过原备份schema、前缀或存在性校验，也不覆盖App既有字段', () => {
  for (const bad of [{ schemaVersion: 2, initialKeys: [], keys: {} }, { schemaVersion: 1, initialKeys: ['unrelated'], keys: { unrelated: { present: true, value: 1 } } }, { schemaVersion: 1, initialKeys: [], keys: { 'dayflow.keep': { present: true, value: 1 } } }]) {
    const run = runtime({ 'dayflow.keep': 7, unrelated: 1 }); stage(run, JSON.stringify(bad));
    assert.throws(() => run.call('finish', [nonce]), /Invalid acceptance backup/); assert.equal(run.writes.length, 0);
    assert.deepEqual(Object.fromEntries(run.store), { 'dayflow.keep': 7, unrelated: 1 }); assert.equal(run.app[SLOT], undefined);
  }
  const run = runtime(); run.app[SLOT] = { userField: true };
  assert.throws(() => run.call('begin', [{ nonce, total: 1, chars: 1, hash: fnv('x') }]), /occupied/);
  assert.deepEqual(run.app[SLOT], { userField: true }); assert.throws(() => run.call('abort', [nonce]));
  const badJson = runtime({ 'dayflow.keep': 7 }); stage(badJson, 'not-json-with-synthetic-data');
  assert.throws(() => badJson.call('finish', [nonce]), /^Error: Restore transfer JSON is invalid$/);
  assert.equal(badJson.writes.length, 0); assert.equal(badJson.app[SLOT], undefined);
});

test('真实PowerShell分块保持Unicode代理对并与JS FNV一致，恢复函数只发送小包', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-restore-transport-'));
  try {
    const script = String.raw`
param([string]$Entry)
$ErrorActionPreference='Stop'
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Entry,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Acceptance entry has invalid syntax'}
foreach($name in @('Get-RestoreTextHash','Split-RestoreText','Ux-RestoreAll')){
 $fn=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$false))[-1]
 . ([scriptblock]::Create($fn.Extent.Text))
}
$text=('a'*8191)+[char]::ConvertFromUtf32(127752)+('中'*30000)
$chunks=Split-RestoreText $text
if(($chunks -join '') -cne $text -or @($chunks|Where-Object {$_.Length -gt 8192}).Count){throw 'Chunk boundaries corrupt Unicode'}
if($chunks[0].Length -ne 8191){throw 'High surrogate split across transport chunks'}
Write-Output (Get-RestoreTextHash $text)
$script:RunDirectory=Split-Path $Entry -Parent
$file=Join-Path $script:RunDirectory 'all-dayflow-backup.json'
# Point the actual function at a temporary directory through a new child folder.
$script:RunDirectory=$env:DAYFLOW_TEST_RESTORE_DIR
[IO.File]::WriteAllText((Join-Path $script:RunDirectory 'all-dayflow-backup.json'),$text,[Text.UTF8Encoding]::new($false))
$script:State=@{restoreNeeded=$true};$script:Pending=$false;$restoreSources=@{begin='begin';part='part';finish='finish';abort='abort'}
$script:sent=0;$script:finished=0
function Save-State{}
function Assert-That([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Evaluate([string]$Source,$Arguments){
 if($Source -eq 'begin'){return @{begun=$true;total=$Arguments[0].total;chars=$Arguments[0].chars}}
 if($Source -eq 'part'){$p=$Arguments[0];if($p.text.Length -gt 8192){throw 'Large request'};$script:sent++;return @{index=$p.index;received=$script:sent;chars=$p.chars}}
 if($Source -eq 'finish'){$script:finished++;return @{equal=$true}}
 if($Source -eq 'abort'){return @{aborted=$true}}
 throw 'Unknown transfer operation'
}
Ux-RestoreAll
if($script:sent -ne $chunks.Count -or $script:finished -ne 1 -or $script:State.restoreTransportNonce){throw 'Incorrect transfer lifecycle'}
Write-Output 'RESTORE_TRANSPORT_PS_OK'
`;
    const file = path.join(directory, 'test.ps1'); fs.writeFileSync(file, script, 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', file, path.resolve(__dirname, '../scripts/wechat-planning-wizard.ps1')], { encoding: 'utf8', timeout: 30000, env: { ...process.env, DAYFLOW_TEST_RESTORE_DIR: directory } });
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    const text = 'a'.repeat(8191) + String.fromCodePoint(127752) + '中'.repeat(30000);
    assert.match(result.stdout, new RegExp(fnv(text))); assert.match(result.stdout, /RESTORE_TRANSPORT_PS_OK/);
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); }
});
