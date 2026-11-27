const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const helpers = require('../scripts/local-backup-acceptance-fixtures');
const { createRuntime, clone } = require('./helpers/miniprogram');
const nonce = '0123456789abcdef0123456789abcdef';
const root = 'wxfile://usr';

function fakePlatform() {
  const files = new Map(), directories = new Set([root, root + '/dayflow-backups']), removed = [], storage = new Map(), app = {}, pages = [{ data: {} }];
  const missing = () => { throw new Error('ENOENT no such file'); };
  const manager = {
    accessSync(name) { if (!files.has(name) && !directories.has(name)) missing(); },
    mkdirSync(name, recursive) { if (files.has(name) || directories.has(name)) { if (recursive && directories.has(name)) return; throw new Error('exists'); } directories.add(name); },
    writeFileSync(name, data, encoding) { assert.ok(directories.has(name.slice(0, name.lastIndexOf('/')))); files.set(name, { data, encoding }); },
    readFileSync(name, encoding) { const file = files.get(name); if (!file) missing(); assert.equal(file.encoding, encoding); return file.data; },
    readdirSync(directory) {
      if (!directories.has(directory)) missing();
      return [...files.keys(), ...directories].filter(name => name.startsWith(directory + '/') && !name.slice(directory.length + 1).includes('/')).map(name => name.slice(directory.length + 1));
    },
    statSync(name) { const file = files.get(name); if (!file && !directories.has(name)) missing(); return { size: file ? Buffer.byteLength(file.data) : 0, isFile: () => !!file, isDirectory: () => !file }; },
    unlinkSync(name) { if (!files.has(name)) missing(); removed.push(name); files.delete(name); },
    rmdirSync(name, recursive) { assert.equal(recursive, false); assert.equal(this.readdirSync(name).length, 0); directories.delete(name); }
  };
  const originals = { chooseMessageFile() {}, shareFileMessage() {}, showModal() {}, setStorageSync(key, value) { storage.set(key, clone(value)); } };
  const wx = { ...originals, env: { USER_DATA_PATH: root }, getFileSystemManager: () => manager, getStorageInfoSync: () => ({ keys: [...storage.keys()] }), getStorageSync: key => clone(storage.get(key)), removeStorageSync: key => storage.delete(key) };
  const call = (name, ...args) => vm.runInNewContext('(' + helpers[name].toString() + ')', { wx, getApp: () => app, getCurrentPages: () => pages, textHash: helpers.textHash })(...args);
  return { files, directories, removed, storage, app, pages, wx, originals, manager, call };
}
const fixtureFiles = [{ name: 'incoming.json', encoding: 'utf8', text: '{"合成":"备份 🟠"}' }, { name: 'synthetic-photo.png', encoding: 'base64', text: 'aGVsbG8=' }];
const expectedId = 'local-backup-acceptance-' + nonce;

test('SDK context verification is read-only and does not compare cross-evaluate function identities', () => {
  const p = fakePlatform();
  for (const name of ['chooseMessageFile', 'shareFileMessage', 'showModal', 'setStorageSync']) {
    Object.defineProperty(p.wx, name, { configurable: true, get: () => function sdkWrapper() {} });
    assert.notEqual(p.wx[name], p.wx[name]);
  }
  p.app.__dayflowLocalBackupAcceptanceV1 = { nonce };
  assert.equal(p.call('sdkContext').harnessAbsent, false);
  delete p.app.__dayflowLocalBackupAcceptanceV1;
  const probe = p.call('sdkContext');
  for (const field of ['appReady', 'pageReady', 'harnessAbsent', 'apisReady']) assert.equal(probe[field], true);
  p.storage.set('dayflow.records.v2', { timestamp: '2026-11-02T00:00:00.000Z', items: [2, 1], nested: { z: 1, a: 2 } });
  const before = clone([...p.storage]), comparison = p.call('storageComparison').text;
  p.storage.set('dayflow.records.v2', { nested: { a: 2, z: 1 }, items: [2, 1], timestamp: '2026-11-02T00:00:00.000Z' });
  assert.equal(p.call('storageComparison').text, comparison);
  assert.deepEqual(clone([...p.storage]), before);
  p.storage.get('dayflow.records.v2').items.reverse();
  assert.notEqual(p.call('storageComparison').text, comparison);
  assert.equal(p.removed.length, 0);
});

test('Repeated file discovery preserves immutable manifest evidence and verifies cleanup without deleting', () => {
  const p = fakePlatform(), fileName = 'dayflow-records-2026-11-02-123-abcd.json', filePath = root + '/dayflow-backups/' + fileName;
  const text = JSON.stringify({ kind: 'dayflow-local-record-backup', data: { plans: { id: expectedId } } });
  p.files.set(filePath, { data: text, encoding: 'utf8' });
  const known = p.call('discoverFiles', { nonce, before: [] }).files;
  p.files.get(filePath).data += ' ';
  assert.throws(() => p.call('discoverFiles', { nonce, before: [], known }), /already recorded/);
  assert.equal(p.call('cleanupAbsent', { nonce, files: known }).absent, false);
  assert.equal(p.removed.length, 0);
  p.files.delete(filePath);
  assert.deepEqual(clone(p.call('discoverFiles', { nonce, before: [], known }).files), clone(known));
  assert.equal(p.call('cleanupAbsent', { nonce, files: known }).absent, true);
  assert.equal(p.removed.length, 0);
});

test('启动前只读门禁保留原页面草稿、等待动作及未完成或损坏的旧恢复点', () => {
  const p = fakePlatform();
  assert.equal(p.call('preflightOriginal').ready, true);
  for (const flag of ['editorVisible','draftResumeAvailable','phaseRulesDirty','restEditorVisible','showFeedbackEditor','showDeferEditor','backupExportReady']) {
    p.pages[0].data = { [flag]: true };
    const before = clone(p.pages);
    assert.equal(p.call('preflightOriginal').draftDetected, true);
    assert.deepEqual(p.pages, before);
  }
  p.pages[0].data = { backupBusy: true };
  assert.equal(p.call('preflightOriginal').busyDetected, true);
  p.pages[0].data = {};
  const raw = Object.fromEntries(['dayflow.plans.v1','dayflow.planVersions.v1','dayflow.instances.v1','dayflow.records.v2','dayflow.records.v1','dayflow.preferences.v1','dayflow.restDays.v1'].map(key => [key, { present: false, value: null }]));
  const text = JSON.stringify({ schemaVersion: 1, kind: 'dayflow-local-record-restore-point', nonce: 'sample-nonce', createdAt: 1, operation: 'restore', before: raw, after: raw });
  const fileName = 'dayflow-restore-1-sample-nonce.json', filePath = root + '/dayflow-backups/' + fileName;
  const point = { schemaVersion: 1, kind: 'dayflow-local-record-restore-manifest', state: 'restored', filePath, fileName, nonce: 'sample-nonce', createdAt: 1, journalByteLength: Buffer.byteLength(text), journalChecksum: 'fnv1a32-utf16le:' + helpers.textHash(text) };
  p.files.set(filePath, { data: text, encoding: 'utf8' });
  p.storage.set('dayflow.localBackup.restorePoint.v1', clone(point));
  assert.equal(p.call('preflightOriginal').ready, true);
  const before = clone([...p.storage]);
  for (const state of ['writing','recovery-required','unknown']) {
    p.storage.set('dayflow.localBackup.restorePoint.v1', { ...point, state });
    assert.equal(p.call('preflightOriginal').recoveryBlocked, true);
  }
  p.storage.set('dayflow.localBackup.restorePoint.v1', clone(point));
  p.files.get(filePath).data += ' ';
  assert.equal(p.call('preflightOriginal').recoveryBlocked, true);
  p.files.get(filePath).data = text;
  p.storage.set('dayflow.localBackup.restorePoint.v1', { ...point, filePath: root + '/foreign-private.json' });
  assert.equal(p.call('preflightOriginal').recoveryBlocked, true);
  p.storage.set('dayflow.localBackup.restorePoint.v1', clone(point));
  assert.deepEqual(clone([...p.storage]), before);
  assert.equal(p.removed.length, 0);
});

test('本机备份验收合成夹具由真实服务生成，历史和照片上下文明确，字节不包含本地路径或账户', () => {
  const now = new Date(2026, 10, 2, 12), fixture = helpers.payload('2026-11-02', now.getTime(), nonce);
  const incoming = JSON.parse(fixture.files.find(file => file.name === 'incoming.json').text);
  assert.ok(Buffer.byteLength(JSON.stringify({ nonce, files: fixture.files }), 'utf8') < 60000, 'native evaluate file arguments must stay bounded');
  assert.equal(incoming.kind, 'dayflow-local-record-backup');
  assert.equal(incoming.data.plans.version, 7);
  assert.equal(Object.keys(incoming.data.records.byDate).length, 2);
  assert.equal(Object.keys(incoming.data.restDays.byDate).length, 1);
  assert.equal(incoming.data.plans.id, expectedId);
  assert.doesNotMatch(JSON.stringify(incoming), /localPath|cloudFileID|sync\.queue|accountMismatch/);
  const runtime = createRuntime(now);
  Object.entries(fixture.original.values).forEach(([key, value]) => runtime.storage.set(key, clone(value)));
  const backup = runtime.load('miniprogram/services/local-backup');
  const before = clone([...runtime.storage]), valid = backup.previewLocalBackup(JSON.stringify(incoming));
  assert.equal(valid.ok, true, valid.errors.join(';'));
  assert.deepEqual(clone([...runtime.storage]), before);
  const incompatible = backup.previewLocalBackup(fixture.files.find(file => file.name === 'photo-incompatible.json').text);
  assert.equal(incompatible.ok, false);
  assert.deepEqual(clone([...runtime.storage]), before);
  for (const value of ['x', 'A'.repeat(32), '../'.repeat(12)]) assert.throws(() => helpers.payload('2026-11-02', now.getTime(), value));
});

test('合成文件夹有唯一所有权标记，重复目录不覆盖且读回保留中文和Unicode', () => {
  const p = fakePlatform();
  const prepared = p.call('setupFiles', { nonce, files: fixtureFiles });
  assert.equal(prepared.prepared, true);
  assert.equal(p.files.get(prepared.directory + '/incoming.json').data, fixtureFiles[0].text);
  const before = [...p.files];
  assert.throws(() => p.call('setupFiles', { nonce, files: fixtureFiles }), /already exists/);
  assert.deepEqual([...p.files], before);
  assert.throws(() => fakePlatform().call('setupFiles', { nonce, files: [{ name: '../other.json', encoding: 'utf8', text: '{}' }] }));
});

test('发现文件仅记录本轮新增且包内nonce归属的导出与journal，既有私有文件不读取', () => {
  const p = fakePlatform(), directory = root + '/dayflow-backups';
  p.files.set(directory + '/existing-private.json', { data: 'not-json-private-existing-file', encoding: 'utf8' });
  const recordName = 'dayflow-records-2026-11-02-12345678-abcd.json';
  const journalName = 'dayflow-restore-12345678-journalnonce.json';
  p.files.set(directory + '/' + recordName, { data: JSON.stringify({ kind: 'dayflow-local-record-backup', data: { plans: { id: expectedId } } }), encoding: 'utf8' });
  p.files.set(directory + '/' + journalName, { data: JSON.stringify({ kind: 'dayflow-local-record-restore-point', nonce: 'journalnonce', before: { 'dayflow.plans.v1': { present: true, value: { id: expectedId } } }, after: { 'dayflow.plans.v1': { present: true, value: { id: expectedId } } } }), encoding: 'utf8' });
  const found = p.call('discoverFiles', { nonce, before: ['existing-private.json'] });
  assert.equal(found.files.length, 2);
  assert.ok(found.files.every(file => file.hash && file.chars));
  p.files.set(directory + '/dayflow-records-123-foreign.json', { data: JSON.stringify({ kind: 'dayflow-local-record-backup', data: { plans: { id: 'another-user-plan' } } }), encoding: 'utf8' });
  assert.throws(() => p.call('discoverFiles', { nonce, before: ['existing-private.json'] }), /not owned/);
  assert.equal(p.removed.length, 0);
});

test('合成文件清理只删除manifest精确文件，旧备份、修改文件与未知目录内容保留', () => {
  for (const damage of ['none', 'changed', 'unexpected', 'unsafe-path', 'preexisting']) {
    const p = fakePlatform(), prepared = p.call('setupFiles', { nonce, files: fixtureFiles });
    const directory = root + '/dayflow-backups', fileName = 'dayflow-records-2026-11-02-123-abcd.json', filePath = directory + '/' + fileName;
    p.files.set(directory + '/old-user-backup.json', { data: 'private-original', encoding: 'utf8' });
    p.files.set(filePath, { data: JSON.stringify({ kind: 'dayflow-local-record-backup', data: { plans: { id: expectedId } } }), encoding: 'utf8' });
    const manifest = p.call('discoverFiles', { nonce, before: ['old-user-backup.json'] }).files;
    if (damage === 'changed') p.files.get(filePath).data += ' ';
    if (damage === 'unexpected') p.files.set(prepared.directory + '/user-note.txt', { data: 'keep', encoding: 'utf8' });
    if (damage === 'unsafe-path') manifest[0].filePath = root + '/some-user-data.json';
    const input = { nonce, before: damage === 'preexisting' ? ['old-user-backup.json', fileName] : ['old-user-backup.json'], files: manifest };
    if (damage === 'none') {
      assert.equal(p.call('cleanupFiles', input).cleaned, true);
      assert.equal(p.files.has(filePath), false);
      assert.equal(p.directories.has(prepared.directory), false);
      assert.equal(p.call('cleanupFiles', input).cleaned, true, 'cleanup retry of absent owned files is safe');
    } else assert.throws(() => p.call('cleanupFiles', input));
    assert.equal(p.files.get(directory + '/old-user-backup.json').data, 'private-original');
    assert.ok(p.removed.every(name => name !== directory + '/old-user-backup.json'));
  }
});

test('受控原生回调仅在独立调用时分享，所有API按值与存在性准确还原', () => {
  const p = fakePlatform();
  delete p.wx.chooseMessageFile;
  assert.equal(p.call('installHarness', { nonce }).installed, true);
  assert.equal(p.call('inspectHarness', nonce).shares, 0);
  p.wx.shareFileMessage({ filePath: root + '/synthetic-only.json', success() {} });
  assert.equal(p.call('inspectHarness', nonce).shares, 1);
  let cancelled = false;
  p.wx.chooseMessageFile({ fail() { cancelled = true; } });
  assert.equal(cancelled, true);
  p.call('setHarness', { nonce, confirm: false, fault: 'once' });
  assert.throws(() => p.wx.setStorageSync('dayflow.records.v2', {}), /Synthetic forward/);
  p.wx.setStorageSync('dayflow.records.v2', { schemaVersion: 2, byDate: {} });
  assert.equal(p.call('restoreHarness', nonce).restored, true);
  assert.equal(Object.hasOwn(p.wx, 'chooseMessageFile'), false);
  assert.equal(p.wx.shareFileMessage, p.originals.shareFileMessage);
  assert.equal(p.wx.setStorageSync, p.originals.setStorageSync);
  assert.equal(p.app.__dayflowLocalBackupAcceptanceV1, undefined);
});

test('专用验收fixture贯通真实profile与备份服务：文件导出、照片保留、恢复撤销及失败恢复', async () => {
  const now = new Date(2026, 10, 2, 12), fixture = helpers.payload('2026-11-02', now.getTime(), nonce);
  const runtime = createRuntime(now), platform = fakePlatform(), app = {};
  runtime.wx.env = { USER_DATA_PATH: root };
  runtime.wx.getFileSystemManager = () => platform.manager;
  const call = (name, ...args) => vm.runInNewContext('(' + helpers[name].toString() + ')', { wx: runtime.wx, getApp: () => app, textHash: helpers.textHash })(...args);
  call('setupFiles', { nonce, files: fixture.files });
  call('seedValues', { nonce, values: fixture.original.values });
  call('installHarness', { nonce });
  const page = runtime.page('profile'); page.onShow();
  page.onToggleSection({ currentTarget: { dataset: { section: 'data' } } }); page.onToggleLocalBackup();
  const before = clone([...runtime.storage]);
  await page.onExportLocalBackup();
  assert.equal(page.data.backupExportReady, true, page.data.backupMessage);
  assert.deepEqual(clone([...runtime.storage]), before);
  assert.equal(call('inspectHarness', nonce).shares, 0);
  await page.onShareLocalBackup(); assert.equal(call('inspectHarness', nonce).shares, 1);
  call('setHarness', { nonce, choice: 'incoming.json', confirm: false });
  await page.onImportLocalBackup();
  assert.equal(page.data.backupPreviewSummary.recordCount, 2, page.data.backupMessage);
  assert.deepEqual(clone([...runtime.storage]), before);
  page.onConfirmLocalBackup(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(clone([...runtime.storage]), before);
  call('setHarness', { nonce, confirm: true });
  page.onConfirmLocalBackup(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.storage.get('dayflow.plans.v1').version, 7, page.data.backupMessage);
  assert.equal(page.data.backupUndoAvailable, true, page.data.backupUndoReason);
  assert.deepEqual(runtime.storage.get('dayflow.media.v1'), before.find(([key]) => key === 'dayflow.media.v1')[1]);
  page.onUndoLocalBackup(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(clone([...runtime.storage]).sort(), before.sort(), page.data.backupMessage);
  call('setHarness', { nonce, choice: 'incoming.json', fault: 'once' });
  await page.onImportLocalBackup(); page.onConfirmLocalBackup(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.backupRecoveryRequired, false, page.data.backupMessage);
  call('setHarness', { nonce, fault: 'none' });
  assert.deepEqual(clone([...runtime.storage]).sort(), before.sort(), page.data.backupMessage);
  await page.onImportLocalBackup(); call('setHarness', { nonce, fault: 'incomplete' });
  page.onConfirmLocalBackup(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.backupRecoveryRequired, true, page.data.backupMessage);
  call('setHarness', { nonce, fault: 'none' });
  page.onUndoLocalBackup(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.backupRecoveryRequired, false, page.data.backupMessage);
  assert.deepEqual(clone([...runtime.storage]).sort(), before.sort());
  const owned = call('discoverFiles', { nonce, before: [] });
  assert.ok(owned.files.some(file => file.kind === 'dayflow-local-record-restore-point'));
  assert.equal(call('restoreHarness', nonce).restored, true);
  assert.equal(call('cleanupFiles', { nonce, before: [], files: owned.files }).cleaned, true);
  assert.equal(platform.files.size, 0);
});

test('暂停计时只经独立确认结束，原执行记录保留且同一备份自动重检但不自动恢复', async () => {
  const now = new Date(2026, 10, 2, 12), fixture = helpers.payload('2026-11-02', now.getTime(), nonce);
  const runtime = createRuntime(now), platform = fakePlatform(), app = {};
  runtime.wx.env = { USER_DATA_PATH: root }; runtime.wx.getFileSystemManager = () => platform.manager;
  const call = (name, ...args) => vm.runInNewContext('(' + helpers[name].toString() + ')', { wx: runtime.wx, getApp: () => app, textHash: helpers.textHash })(...args);
  call('setupFiles', { nonce, files: fixture.files }); call('seedValues', { nonce, values: fixture.paused.values }); call('installHarness', { nonce });
  const page = runtime.page('profile'); page.onShow(); page.onToggleSection({ currentTarget: { dataset: { section: 'data' } } }); page.onToggleLocalBackup();
  const before = clone([...runtime.storage]);
  call('setHarness', { nonce, choice: 'incoming.json', confirm: false }); await page.onImportLocalBackup();
  assert.equal(page.data.backupTimerBlocked, true); assert.equal(page.data.backupPreviewSummary, null);
  page.onClearLocalBackupTimer(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(clone([...runtime.storage]).sort(), before.sort());
  call('setHarness', { nonce, confirm: true }); page.onClearLocalBackupTimer(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.storage.has('dayflow.timer.v1'), false, page.data.backupMessage);
  assert.equal(page.data.backupTimerBlocked, false);
  assert.equal(page.data.backupPreviewSummary.recordCount, 2, page.data.backupMessage);
  assert.deepEqual(clone([...runtime.storage]).sort(), before.filter(([key]) => key !== 'dayflow.timer.v1').sort());
  assert.equal(runtime.storage.get('dayflow.plans.v1').version, 1);
  call('restoreHarness', nonce); call('cleanupFiles', { nonce, before: [], files: [] });
});

test('专用PowerShell仅导入定义，保留全键备份、分块双恢复、文件清理和pending防重放', () => {
  const entry = path.join(__dirname, '../scripts/wechat-local-backup.ps1'), source = fs.readFileSync(entry, 'utf8');
  assert.match(source, /ValidateSet\('Validate','Layout','Restore','Poll'\)/);
  assert.match(source, /-Filter active-run\.json -Recurse -File/);
  assert.match(source, /previous\.pending -or \$previous\.restoreNeeded/);
  assert.match(source, /check_wechatide_status' @\('--skill-version','0\.3\.11'\)/);
  assert.match(source, /\$status\.loginExpired -ne \$false/);
  assert.match(source, /'Get-RestoreTextHash','Split-RestoreText','Ux-RestoreAll'/);
  assert.match(source, /if\(-not \$script:State\.storageRestored\)\{Bk-RestoreStorage\}/);
  assert.match(source, /\$script:State\.fileCleanupNeeded -or -not \[bool\]\$script:State\.storageRestored/);
  assert.match(source, /if\(\$Mode -in @\('Validate','Layout'\) -and \$script:State\.restoreNeeded -and -not \$script:Pending\)/);
  assert.match(source, /\$sourceMode=if\(\$Mode -in @\('Restore','Poll'\)\)\{@\('--sources-only'\)\}/);
  assert.ok(source.indexOf('all-dayflow-backup.json') < source.indexOf("$prepared=Bk-Evaluate 'setupFiles'"));
  assert.doesNotMatch(source, /\bclearStorage|Remove-Item|rmdir\s+\/s|cmd\s+\/c|callMethod|setData/);
  const wizard = fs.readFileSync(path.join(__dirname, '../scripts/wechat-planning-wizard.ps1'), 'utf8');
  assert.match(wizard, /foreach\(\$kind in @\([^\r\n]*'wechat-local-backup'/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-backup-ps-'));
  try {
    const file = path.join(directory, 'syntax.ps1');
    fs.writeFileSync(file, "param([string]$Entry)\n$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile($Entry,[ref]$null,[ref]$e)\nif($e.Count){throw 'Invalid local backup runner syntax'}\nfunction Assert-That([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}\n$bindingFailed=$false;try{Assert-That 'message' 'unexpected'}catch{$bindingFailed=$true}\nif(-not $bindingFailed){throw 'Original string binding was not reproduced'}\nAssert-That ([bool]'message') 'Explicit boolean cast failed'\n'BACKUP_PS_OK'", 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', file, entry], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /BACKUP_PS_OK/);
    const definitions = spawnSync(process.execPath, [path.join(__dirname, '../scripts/local-backup-acceptance-fixtures.js'), 'not-a-date', 'not-a-nonce', '--sources-only'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(definitions.status, 0, definitions.stderr);
    const parsed = JSON.parse(definitions.stdout);
    assert.equal(parsed.payload, null);
    assert.match(parsed.restoreHarness, /function restoreHarness/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
