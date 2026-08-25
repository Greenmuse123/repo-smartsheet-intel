# Orderly

Orderly is a small order-tracking API for a bakery: customers place orders, staff mark them baked and picked up, and the owner sees a daily summary.

## Getting started

```
npm install
npm test
```

## Roadmap

- [x] Create and list orders
- [x] Mark an order as baked
- [ ] Email the customer when an order is ready (#42)
- [ ] Daily summary report for the owner
- [ ] Support gift cards as a payment method

## Known issues

- [ ] Session tokens never expire (see src/auth/session.js)
