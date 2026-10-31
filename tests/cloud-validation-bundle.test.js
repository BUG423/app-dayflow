const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildContents } = require('../cloudfunctions/dayflowSync/build-validation');
test('云函数打包的纯校验器与前端源一致且不导入微信客户端服务', () => {
  for (const [name, content] of Object.entries(buildContents())) {
    assert.equal(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/dayflowSync/shared', name), 'utf8'), content,
      'Run node cloudfunctions/dayflowSync/build-validation.js after changing shared validators');
    assert.doesNotMatch(content, /\bwx\./);
  }
});
