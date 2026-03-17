const express = require('express');
const mqtt = require('mqtt');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

// Import SQLite logic
const sqliteDB = require('./config/sqlite_database');
const webRoutes = require('./routes/webRoutes');
const authRoutes = require('./routes/authRoutes');
const productRoutesModule = require('./routes/productRoutes');
const productRoutes = productRoutesModule.router;

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH"]
  }
});

// Setup classic WebSocket for the Web Dashboard
const wss = new WebSocket.Server({ noServer: true });

function legacyBroadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Pass broadcast to webRoutes
webRoutes.setBroadcast(legacyBroadcast);

app.use(cors());
app.use(express.json());

// Mount auth routes
app.use('/', authRoutes);

// Mount product routes
app.use('/api', productRoutes);

// Mount SQLite Web routes
app.use('/web/api', webRoutes);

// Static file serving for web dashboard and mobile app
app.use('/web', express.static(path.join(__dirname, 'web_public')));
app.use('/mobile', express.static(path.join(__dirname, 'mobile_dist')));

// Fallback for mobile app absolute paths (Expo bundles often use absolute paths)
app.use('/_expo', express.static(path.join(__dirname, 'mobile_dist', '_expo')));
app.use('/assets', express.static(path.join(__dirname, 'mobile_dist', 'assets')));
app.use('/favicon.ico', express.static(path.join(__dirname, 'mobile_dist', 'favicon.ico')));

const PORT = process.env.PORT1 || 9271;
const TEAM_ID = "1nt3ern4l_53rv3r_3rr0r";
const MQTT_BROKER = "mqtt://broker.hivemq.com:1883";
const SECRET_KEY = process.env.JWT_SECRET || 'secret123';

// Passcode helper functions
async function hashPasscode(passcode) {
  return await bcrypt.hash(passcode, 10);
}

async function verifyPasscode(inputPasscode, hashedPasscode) {
  if (!hashedPasscode) return false;
  return await bcrypt.compare(inputPasscode, hashedPasscode);
}

// Authentication middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// MQTT Topics
const TOPIC_STATUS = `rfid/${TEAM_ID}/card/status`;
const TOPIC_BALANCE = `rfid/${TEAM_ID}/card/balance`;
const TOPIC_TOPUP = `rfid/${TEAM_ID}/card/topup`;
const TOPIC_PAYMENT = `rfid/${TEAM_ID}/card/payment`;
const TOPIC_REMOVED = `rfid/${TEAM_ID}/card/removed`;

// --- MODERN DASHBOARD ROUTES (SQLite) ---

app.get('/api/dashboard', authenticate, async (req, res) => {
  try {
    const stats = sqliteDB.getDashboardStats();
    res.json(stats);
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

app.get('/api/transactions', authenticate, async (req, res) => {
  try {
    const transactions = sqliteDB.getAllTransactions();
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// --- MQTT CLIENT SETUP ---

const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
  console.log('Connected to MQTT Broker');
  mqttClient.subscribe(TOPIC_STATUS);
  mqttClient.subscribe(TOPIC_BALANCE);
  mqttClient.subscribe(TOPIC_PAYMENT);
  mqttClient.subscribe(TOPIC_REMOVED);
  mqttClient.subscribe(TOPIC_TOPUP);
});

mqttClient.on('message', (topic, message) => {
  const msgStr = message.toString();
  try {
    const parsed = JSON.parse(msgStr);

    // Legacy Web Relay
    if (topic === TOPIC_STATUS) {
      const card = sqliteDB.getCard(parsed.uid);
      legacyBroadcast("card_scan", {
        uid: parsed.uid,
        espBalance: parsed.balance,
        registered: !!card,
        card: card || null,
      });

      // Modern Mobile Relay
      io.emit('card-status', {
        uid: parsed.uid,
        balance: card ? card.balance : 0,
        holderName: card ? card.card_holder : null,
        status: parsed.status,
        present: parsed.present,
        ts: parsed.ts
      });
    } else if (topic === TOPIC_BALANCE) {
      const card = sqliteDB.getCard(parsed.uid);
      legacyBroadcast("balance_update", {
        uid: parsed.uid,
        newBalance: parsed.new_balance,
        card: card || null,
      });
      io.emit('card-balance', parsed);
    } else if (topic === TOPIC_PAYMENT) {
      io.emit('payment-result', parsed);
    } else if (topic === TOPIC_REMOVED) {
      io.emit('card-removed', parsed);
    }
  } catch (e) {
    console.error("MQTT Message Error:", e);
  }
});

// --- MODERN APP HTTP ENDPOINTS (SQLite) ---

app.post('/topup', authenticate, async (req, res) => {
  const { uid, amount, holderName } = req.body;
  
  if (!uid || amount === undefined) {
    return res.status(400).json({ error: 'UID and amount are required' });
  }

  try {
    let card = sqliteDB.getCard(uid);
    if (!card) {
      if (!holderName) {
        return res.status(400).json({ error: 'Holder name is required for new cards' });
      }
      card = sqliteDB.registerCard(uid, holderName);
    }

    const result = sqliteDB.safeTopup(uid, amount, req.user.username, `Top-up of $${amount}`);
    
    if (result.success) {
      // Notify ESP8266
      mqttClient.publish(TOPIC_TOPUP, JSON.stringify({ uid, amount: result.balanceAfter }));
      
      // Notify Dashboards
      io.emit('card-balance', { uid, balance: result.balanceAfter });
      legacyBroadcast("balance_update", { uid, newBalance: result.balanceAfter, card });

      res.json({
        success: true,
        card: { uid, holderName: card.card_holder, balance: result.balanceAfter },
        transaction: result
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: 'Topup failed' });
  }
});

app.post('/pay', authenticate, async (req, res) => {
  const { uid, productId, amount, description, passcode } = req.body;

  try {
    const card = sqliteDB.getCard(uid);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    if (card.passcode_set) {
      if (!passcode || !(await verifyPasscode(passcode, card.passcode))) {
        return res.status(401).json({ error: 'Invalid or missing passcode', passcodeRequired: true });
      }
    }

    let result;
    if (productId) {
      result = sqliteDB.safePayment(uid, productId, 1, req.user.username);
    } else {
      // Custom payment logic (needs safePayment variant or direct transaction)
      // For simplicity here, use a variant of topup with negative amount if needed, 
      // but safePayment is cleaner. I'll stick to productId or add a generic payment helper later.
      return res.status(400).json({ error: 'Product ID required for this integrated version' });
    }

    if (result.success) {
      mqttClient.publish(TOPIC_PAYMENT, JSON.stringify({
        uid,
        amount: result.balanceAfter,
        deducted: result.totalCost,
        status: 'success'
      }));
      
      io.emit('payment-success', {
        uid,
        holderName: card.card_holder,
        amount: result.totalCost,
        balanceAfter: result.balanceAfter
      });

      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.post('/card/:uid/set-passcode', async (req, res) => {
  const { passcode } = req.body;
  if (!passcode || !/^\d{6}$/.test(passcode)) return res.status(400).json({ error: '6-digit passcode required' });

  try {
    const hashed = await hashPasscode(passcode);
    sqliteDB.updatePasscode(req.params.uid, hashed);
    res.json({ success: true, message: 'Passcode set' });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/card/:uid', async (req, res) => {
  const card = sqliteDB.getCard(req.params.uid);
  card ? res.json(card) : res.status(404).json({ error: 'Not found' });
});

app.get('/api/cards', async (req, res) => {
  res.json(sqliteDB.getAllCards());
});

app.get('/api/users', authenticate, (req, res) => {
  res.json(sqliteDB.getUsers());
});

app.post('/api/cards/register', async (req, res) => {
  const { uid, holderName } = req.body;
  try {
    const user = sqliteDB.getUser(holderName);
    if (!user) return res.status(400).json({ error: 'User not found' });
    
    sqliteDB.registerCard(uid, holderName);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/transactions/:uid', (req, res) => {
  res.json(sqliteDB.getCardTransactions(req.params.uid));
});

// --- SERVER INITIALIZATION ---

io.on('connection', (socket) => {
  console.log('Client connected to Socket.IO');
});

// Robust upgrade handler
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/web/ws' || pathname === '/web/ws/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (!pathname.startsWith('/socket.io/')) {
    // If it's not socket.io and not our /web/ws, close it to avoid hangs
    // socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Unified SQLite server running on port ${PORT}`);
});
