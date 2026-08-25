const test = require('node:test');
const assert = require('node:assert');
const { money } = require('../src/utils/format');

test('formats cents as dollars', () => {
  assert.strictEqual(money(1250), '$12.50');
});
