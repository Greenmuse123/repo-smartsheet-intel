const test = require('node:test');
const assert = require('node:assert');
const orders = require('../src/orders/service');

test('creates an order with a number', () => {
  const o = orders.create({ items: ['croissant'] });
  assert.ok(o.number > 0);
});
