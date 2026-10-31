const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Runs real page/service modules with an isolated WeChat API and controllable device clock.
// This verifies application logic only, not WXML rendering or the WeChat simulator.
function createRuntime(initialDate = new Date(2026, 9, 31, 12, 4)) {
  let now = initialDate;
  let nextTimer = 0;
  const timers = new Map();
  const storage = new Map();
  const calls = { toasts: [], modals: [], navigations: [] };
  class DeviceDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  const wx = {
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    showToast: value => calls.toasts.push(value),
    showModal: value => calls.modals.push(value),
    navigateTo: value => calls.navigations.push(value),
    navigateBack: () => calls.navigations.push({ back: true }),
    stopPullDownRefresh() {},
    setClipboardData() {}
  };
  const cache = new Map();
  let capturedPage;
  const globals = {
    wx, Date: DeviceDate,
    Page: config => { capturedPage = config; },
    setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: id => timers.delete(id)
  };
  function load(relative, parent = root) {
    let filename = path.resolve(parent, relative);
    if (!path.extname(filename)) filename += fs.existsSync(filename + '.ts') ? '.ts' : '.js';
    if (!filename.startsWith(root + path.sep)) throw new Error('Module outside project');
    if (cache.has(filename)) return cache.get(filename).exports;
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.ts')) {
      source = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS }
      }).outputText;
    }
    const module = { exports: {} };
    cache.set(filename, module);
    vm.runInNewContext(source, {
      ...globals, module, exports: module.exports,
      require: specifier => load(specifier, path.dirname(filename))
    }, { filename });
    return module.exports;
  }
  function page(name) {
    capturedPage = undefined;
    load('miniprogram/pages/' + name + '/index.ts');
    if (!capturedPage) throw new Error('Page not registered');
    const instance = { ...capturedPage, data: clone(capturedPage.data), updates: 0 };
    instance.setData = patch => { Object.assign(instance.data, clone(patch)); instance.updates++; };
    return instance;
  }
  return {
    page, load, wx, storage, calls, timers,
    setNow(value) { now = value; },
    tick() { for (const callback of [...timers.values()]) callback(); }
  };
}

module.exports = { createRuntime, clone };
