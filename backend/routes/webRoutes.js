const express = require('express');
const router = express.Router();
const sqliteDB = require('../config/sqlite_database');

// Broadcast helper (will be set from server.js)
let broadcast = () => {};
router.setBroadcast = (fn) => { broadcast = fn; };

// Auth Endpoints
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const user = sqliteDB.getUser(username);
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid username or password' });

  res.json({ username: user.username, role: user.role });
});

router.post('/signup', (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !role)
    return res.status(400).json({ error: 'Username, password, and role required' });

  if (!['agent', 'cashier', 'admin'].includes(role))
    return res.status(400).json({ error: 'Role must be agent, cashier, or admin' });

  try {
    if (sqliteDB.getUser(username))
      return res.status(409).json({ error: 'Username already taken' });
    sqliteDB.createUser(username, password, role);
    res.json({ username, role });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Card Endpoints
router.get('/cards', (req, res) => res.json(sqliteDB.getAllCards()));

router.get('/cards/:uid', (req, res) => {
  const card = sqliteDB.getCard(req.params.uid);
  if (!card) return res.status(404).json({ error: 'Card not registered' });
  res.json(card);
});

router.post('/cards/register', (req, res) => {
  const { uid, cardHolder } = req.body || {};
  if (!uid || !cardHolder)
    return res.status(400).json({ error: 'UID and card holder name required' });

  const existing = sqliteDB.getCard(uid);
  if (existing)
    return res.status(409).json({ error: 'Card already registered', card: existing });

  try {
    const card = sqliteDB.registerCard(uid, cardHolder);
    broadcast('card_registered', { card });
    res.json({ status: 'registered', card });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register card' });
  }
});

// Topup Endpoint
router.post('/topup', (req, res) => {
  const { uid, amount } = req.body || {};
  if (!uid || !amount)
    return res.status(400).json({ error: 'Missing UID or amount' });

  const result = sqliteDB.safeTopup(uid, Math.floor(amount));
  if (!result.success) return res.status(400).json({ error: result.error });

  // MQTT logic should be in server.js or shared
  // For now, focus on DB and WS
  broadcast('topup_success', {
    uid, amount: Math.floor(amount),
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
    card: result.card,
  });

  res.json({
    status: 'success', uid, amount: Math.floor(amount),
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
    card: result.card,
  });
});

// Payment Endpoint
router.post('/pay', (req, res) => {
  const { uid, items, productId, quantity } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing UID' });

  let result;
  if (items && Array.isArray(items) && items.length > 0) {
    result = sqliteDB.safeCartPayment(uid, items);
  } else if (productId && quantity) {
    result = sqliteDB.safePayment(uid, productId, Math.floor(quantity));
  } else {
    return res.status(400).json({ error: 'Missing items or product' });
  }

  if (!result.success)
    return res.status(400).json({ status: 'declined', error: result.error });

  const itemsList = result.items
    ? result.items.map((i) => ({ name: i.product.name, quantity: i.quantity, lineCost: i.lineCost }))
    : [{ name: result.product.name, quantity: result.quantity, lineCost: result.totalCost }];

  broadcast('payment_success', {
    uid, items: itemsList, totalCost: result.totalCost,
    balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, card: result.card,
  });

  res.json({
    status: 'approved', uid, items: itemsList, totalCost: result.totalCost,
    balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter, card: result.card,
  });
});

// Product Endpoints
router.get('/products', (req, res) => res.json(sqliteDB.getProducts()));

router.post('/products', (req, res) => {
  const { name, price, category } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
  try {
    const product = sqliteDB.addProduct(name, Math.floor(price), category);
    broadcast('product_added', { product });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add product' });
  }
});

router.put('/products/:id', (req, res) => {
  const { name, price, category } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
  try {
    const product = sqliteDB.updateProduct(Number(req.params.id), name, Math.floor(price), category);
    broadcast('product_updated', { product });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/products/:id', (req, res) => {
  try {
    sqliteDB.deleteProduct(Number(req.params.id));
    broadcast('product_deleted', { id: Number(req.params.id) });
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Dashboard & Transaction Endpoints
router.get('/dashboard', (req, res) => res.json(sqliteDB.getDashboardStats()));

router.get('/transactions', (req, res) => {
  const { uid } = req.query;
  res.json(uid ? sqliteDB.getCardTransactions(uid) : sqliteDB.getAllTransactions());
});

module.exports = router;
