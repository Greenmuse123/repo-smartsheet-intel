const express = require('express');
const orders = require('./orders/service');
const app = express();
app.use(express.json());
app.get('/orders', (req, res) => res.json(orders.list()));
app.post('/orders', (req, res) => res.status(201).json(orders.create(req.body)));
module.exports = app;
