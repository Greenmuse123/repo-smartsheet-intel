const Stripe = require('stripe');

function charge(amountCents, sourceToken) {
  // HACK: hard-coded currency until we support CAD (ORD-17)
  const stripe = new Stripe(process.env.STRIPE_KEY);
  return stripe.charges.create({ amount: amountCents, currency: 'usd', source: sourceToken });
}

module.exports = { charge };
