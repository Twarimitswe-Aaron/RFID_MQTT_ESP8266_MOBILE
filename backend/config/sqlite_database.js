const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'wallet.db'));

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ==========================================================
   SCHEMA INITIALIZATION
   ========================================================== */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK(role IN ('user', 'agent', 'cashier', 'admin')),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cards (
    uid           TEXT    PRIMARY KEY,
    card_holder   TEXT    NOT NULL, -- Alias for holderName
    balance       INTEGER NOT NULL DEFAULT 0,
    last_topup    INTEGER DEFAULT 0,
    passcode      TEXT    DEFAULT NULL,
    passcode_set  INTEGER DEFAULT 0, -- 1 for true, 0 for false
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id        TEXT    PRIMARY KEY, -- String ID to match modern backend
    name      TEXT    NOT NULL,
    price     REAL    NOT NULL,
    category  TEXT    NOT NULL DEFAULT 'General',
    active    INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uid             TEXT    NOT NULL,
    type            TEXT    NOT NULL CHECK(type IN ('TOPUP', 'PAYMENT', 'topup', 'debit')),
    amount          REAL    NOT NULL,
    balance_before  REAL    NOT NULL,
    balance_after   REAL    NOT NULL,
    userId          TEXT, -- Modern backend track who did it
    description     TEXT, -- Modern backend description
    product_id      TEXT,
    product_name    TEXT,
    quantity        INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uid) REFERENCES cards(uid)
  );
`);

/* ==========================================================
   PREPARED STATEMENTS
   ========================================================== */
const stmts = {
  // Users
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  createUser: db.prepare(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
  ),

  // Cards
  getCard: db.prepare('SELECT * FROM cards WHERE uid = ?'),
  getAllCards: db.prepare(
    'SELECT * FROM cards ORDER BY registered_at DESC',
  ),
  registerCard: db.prepare(
    'INSERT INTO cards (uid, card_holder, balance) VALUES (?, ?, 0)',
  ),
  updateBalance: db.prepare('UPDATE cards SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ?'),
  updatePasscode: db.prepare('UPDATE cards SET passcode = ?, passcode_set = 1, updated_at = CURRENT_TIMESTAMP WHERE uid = ?'),
  updateTopupTime: db.prepare('UPDATE cards SET last_topup = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ?'),
  updateHolder: db.prepare('UPDATE cards SET card_holder = ?, updated_at = CURRENT_TIMESTAMP WHERE uid = ?'),

  // Products
  getProducts: db.prepare(
    'SELECT * FROM products WHERE active = 1 ORDER BY category, name',
  ),
  getProduct: db.prepare('SELECT * FROM products WHERE id = ?'),
  addProduct: db.prepare(
    'INSERT INTO products (id, name, price, category) VALUES (?, ?, ?, ?)',
  ),
  updateProduct: db.prepare(
    'UPDATE products SET name = ?, price = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ),
  deleteProduct: db.prepare('UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),

  // Transactions
  createTransaction: db.prepare(`
    INSERT INTO transactions (uid, type, amount, balance_before, balance_after, userId, description, product_id, product_name, quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAllTransactions: db.prepare(
    'SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200',
  ),
  getCardTransactions: db.prepare(
    'SELECT * FROM transactions WHERE uid = ? ORDER BY created_at DESC LIMIT 50',
  ),

  // Dashboard
  totalTopupsToday: db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM transactions
    WHERE (type = 'TOPUP' OR type = 'topup') AND date(created_at) = date('now')
  `),
  totalPaymentsToday: db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM transactions
    WHERE (type = 'PAYMENT' OR type = 'debit') AND date(created_at) = date('now')
  `),
  activeCards: db.prepare('SELECT COUNT(*) AS count FROM cards'),
  totalBalance: db.prepare(
    'SELECT COALESCE(SUM(balance), 0) AS total FROM cards',
  ),
  getUsers: db.prepare('SELECT id, username, role FROM users ORDER BY username ASC'),
};

/* ==========================================================
   DATABASE API
   ========================================================== */

module.exports = {
  getUser: (username) => stmts.getUser.get(username),
  createUser: (username, password, role) => stmts.createUser.run(username, password, role),
  getCard: (uid) => stmts.getCard.get(uid),
  getAllCards: () => stmts.getAllCards.all(),
  registerCard: (uid, cardHolder) => {
    stmts.registerCard.run(uid, cardHolder);
    return stmts.getCard.get(uid);
  },
  
  updatePasscode: (uid, hashedPasscode) => {
    return stmts.updatePasscode.run(hashedPasscode, uid);
  },

  updateHolder: (uid, holderName) => {
    return stmts.updateHolder.run(holderName, uid);
  },

  getUsers: () => stmts.getUsers.all(),

  getProducts: () => stmts.getProducts.all(),
  getProduct: (id) => stmts.getProduct.get(id),
  addProduct: (id, name, price, category) => {
    stmts.addProduct.run(id, name, price, category || 'General');
    return stmts.getProduct.get(id);
  },
  updateProduct: (id, name, price, category) => {
    stmts.updateProduct.run(name, price, category || 'General', id);
    return stmts.getProduct.get(id);
  },
  deleteProduct: (id) => stmts.deleteProduct.run(id),

  safeTopup: (uid, amount, userId = 'system', description = 'Top-up') => {
    const topupTx = db.transaction(() => {
      const card = stmts.getCard.get(uid);
      if (!card) throw new Error('Card not registered');

      const balanceBefore = card.balance;
      const balanceAfter = balanceBefore + amount;

      stmts.updateBalance.run(balanceAfter, uid);
      stmts.updateTopupTime.run(Math.floor(Date.now() / 1000), uid);

      stmts.createTransaction.run(
        uid,
        'topup',
        amount,
        balanceBefore,
        balanceAfter,
        userId,
        description,
        null,
        null,
        null,
      );

      return {
        card: { ...card, balance: balanceAfter },
        balanceBefore,
        balanceAfter,
      };
    });

    try {
      const result = topupTx();
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  safePayment: (uid, productId, quantity, userId = 'customer', description = 'Payment') => {
    const payTx = db.transaction(() => {
      const card = stmts.getCard.get(uid);
      if (!card) throw new Error('Card not registered');

      const product = stmts.getProduct.get(productId);
      if (!product || !product.active) throw new Error('Product not found');

      const totalCost = product.price * quantity;
      if (card.balance < totalCost) {
        throw new Error(
          `Insufficient balance. Need ${totalCost}, have ${card.balance}`,
        );
      }

      const balanceBefore = card.balance;
      const balanceAfter = balanceBefore - totalCost;

      stmts.updateBalance.run(balanceAfter, uid);

      stmts.createTransaction.run(
        uid,
        'debit',
        totalCost,
        balanceBefore,
        balanceAfter,
        userId,
        description,
        productId,
        product.name,
        quantity,
      );

      return {
        card: { ...card, balance: balanceAfter },
        product,
        quantity,
        totalCost,
        balanceBefore,
        balanceAfter,
      };
    });

    try {
      const result = payTx();
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  getDashboardStats: () => {
    const topups = stmts.totalTopupsToday.get();
    const payments = stmts.totalPaymentsToday.get();
    const cards = stmts.activeCards.get();
    const balance = stmts.totalBalance.get();

    return {
      topupsToday: topups,
      paymentsToday: payments,
      activeCards: cards.count,
      totalBalance: balance.total,
    };
  },

  getAllTransactions: () => stmts.getAllTransactions.all(),
  getCardTransactions: (uid) => stmts.getCardTransactions.all(uid),
};
