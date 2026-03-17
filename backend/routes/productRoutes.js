const express = require('express');
const sqliteDB = require('../config/sqlite_database');

const router = express.Router();

// Authentication middleware (simplified - should match main server)
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  // JWT verification is usually handled by a main middleware in server.js
  // But for this router, we assume the user object is already on req if verified
  next();
};

// Get all products
router.get('/products', async (req, res) => {
  try {
    const products = sqliteDB.getProducts();
    res.json(products);
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Add new product
router.post('/products', async (req, res) => {
  const { id, name, price, category } = req.body;

  if (!id || !name || price === undefined || !category) {
    return res.status(400).json({ error: 'ID, name, price, and category are required' });
  }

  if (price <= 0) {
    return res.status(400).json({ error: 'Price must be positive' });
  }

  try {
    const existing = sqliteDB.getProduct(id);
    if (existing) {
      return res.status(400).json({ error: 'Product ID already exists' });
    }

    const product = sqliteDB.addProduct(id, name, parseFloat(price), category);
    res.status(201).json({ success: true, product });
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Update product
router.put('/products/:id', async (req, res) => {
  const { name, price, category } = req.body;

  if (!name || price === undefined || !category) {
    return res.status(400).json({ error: 'Name, price, and category are required' });
  }

  try {
    const product = sqliteDB.updateProduct(req.params.id, name, parseFloat(price), category);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ success: true, product });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product
router.delete('/products/:id', async (req, res) => {
  try {
    sqliteDB.deleteProduct(req.params.id);
    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = { router };
