const db = [];
let nextNumber = 1;

function create(input) {
  // TODO(maria): validate that items[] is not empty before saving
  const order = { number: nextNumber++, status: 'placed', ...input };
  db.push(order);
  return order;
}

function list() {
  return db;
}

function markBaked(number) {
  const o = db.find((x) => x.number === number);
  if (o) o.status = 'baked';
  // TODO: send the "your order is ready" email, depends on #42
  return o;
}

// TODO(P1): daily summary report for the owner - group by status and total revenue
module.exports = { create, list, markBaked };
