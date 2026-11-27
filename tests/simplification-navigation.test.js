const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRuntime, clone } = require('./helpers/miniprogram');

test('LEAN-01 三个中文主入口保留记录详情路由，记录使用原生非Tab导航', () => {
  const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.deepEqual(app.tabBar.list.map(item => [item.pagePath, item.text]), [
    ['pages/today/index', '今日'], ['pages/plans/index', '计划'], ['pages/profile/index', '我的']
  ]);
  assert.ok(app.pages.includes('pages/stats/index'));
  assert.ok(app.pages.includes('pages/training/index'));
  const runtime = createRuntime();
  runtime.wx.switchTab = () => { throw new Error('Records must use navigateTo'); };
  const profile = runtime.page('profile'); profile.onShow();
  const before = clone([...runtime.storage]);
  profile.onOpenRecords();
  assert.deepEqual(clone(runtime.calls.navigations), [{ url: '/pages/stats/index' }]);
  assert.deepEqual(clone([...runtime.storage]), before);
});

test('LEAN-01 由我的进入记录后仍能筛选和查看执行事件，返回主页面不改变事实', () => {
  const runtime = createRuntime();
  const records = runtime.load('miniprogram/services/records');
  records.setStatus('2026-10-31', 'music-guitar', 'done');
  records.setStatus('2026-10-30', 'music-vocal', 'done');
  const profile = runtime.page('profile'); profile.onShow();
  const before = clone(runtime.storage.get('dayflow.records.v2'));
  profile.onOpenRecords();
  const stats = runtime.page('stats'); stats.onShow();
  assert.equal(stats.data.historyVisible, false);
  stats.onToggleHistory();
  assert.equal(stats.data.historyVisible, true);
  stats.onHistoryFromChange({ detail: { value: '2026-10-31' } });
  stats.onHistoryToChange({ detail: { value: '2026-10-31' } });
  stats.onApplyHistoryRange();
  assert.ok(stats.data.historyRecords.every(item => item.date === '2026-10-31'));
  const row = stats.data.historyRecords.find(item => item.recordKey === '2026-10-31:music-guitar');
  assert.ok(row, 'retained execution record remains reachable');
  stats.onToggleHistoryRecord({ currentTarget: { dataset: { id: row.recordKey } } });
  assert.equal(stats.data.historyRecords.find(item => item.recordKey === row.recordKey).expanded, true);
  profile.onShow();
  const today = runtime.page('today'); today.onLoad();
  const plans = runtime.page('plans'); plans.onShow();
  assert.deepEqual(clone(runtime.storage.get('dayflow.records.v2')), before);
  assert.equal(today.data.blocks.find(item => item.id === 'music').actions[0].done, true);
});

test('LEAN 验收导航helper以navigateTo打开记录，仅三个主页面使用switchTab', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-lean-navigation-'));
  try {
    const fixture = String.raw`
param([string]$Source)
$ErrorActionPreference='Stop'
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$errors)
if($errors.Count){throw 'UX script syntax error'}
$fn=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ux-Go'},$false)[0]
. ([scriptblock]::Create($fn.Extent.Text))
$script:Actions=@();$script:Waits=@()
function Invoke-Ide($Tool,$Arguments,[switch]$ProjectTool){
  if($Tool -ne 'automation_navigate' -or -not $ProjectTool){throw 'Unexpected tool'}
  $script:Actions+=,@($Arguments)
}
function Wait-UxPage($Path,$Selector,$Key){$script:Waits+=@{path=$Path;selector=$Selector;key=$Key};return @{ready=$true}}
foreach($route in @('today','plans','profile','stats')){
  $page=Ux-Go ('pages/'+$route+'/index') '.anchor' 'ready'
  if(-not $page.ready){throw 'Navigation returned before page readiness'}
}
if($script:Actions.Count -ne 4 -or $script:Waits.Count -ne 4){throw 'Navigation replayed or omitted'}
foreach($index in 0..3){
  $expected=if($index -eq 3){'navigateTo'}else{'switchTab'}
  $arguments=$script:Actions[$index]
  if($arguments.Count -ne 4 -or $arguments[0] -ne '--action' -or $arguments[1] -ne $expected -or $arguments[2] -ne '--url' -or $arguments[3] -ne ('/'+$script:Waits[$index].path)){throw 'Wrong route type or URL'}
}
Write-Output 'LEAN_NAVIGATION_OK'
`;
    const filename = path.join(directory, 'navigation.ps1'); fs.writeFileSync(filename, fixture, 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-File', filename,
      path.resolve(__dirname, '../scripts/wechat-ux.ps1')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /LEAN_NAVIGATION_OK/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
