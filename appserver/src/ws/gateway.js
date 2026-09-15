require('dotenv').config();
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db.js');
const { JWT_SECRET } = require('../routes/auth.js');

const VALID_INSTRUMENTS = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];

/**
 * ============================================================================
 * 60 FPS Real-Time WebSocket Gateway with Room Management & Native Order Entry
 * ============================================================================
 */
class WebSocketGateway {
  constructor(httpServer, options = {}, kafkaProducer = null) {
    this.wss = new WebSocketServer({ 
      server: httpServer,
      path: options.path || '/ws'
    });

    this.producer = kafkaProducer;

    this.rooms = new Map();
    this.traderSockets = new Map();

    this.setupServer();

    this.heartbeatInterval = setInterval(() => this.pruneDeadConnections(), 30000);
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  setupServer() {
    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.subscriptions = new Set();
      ws.traderId = null;
      ws.username = null;
      ws.role = 'TRADER';

      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');

      if (token) {
        this.authenticateSocket(ws, token);
      }

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (messageRaw) => {
        try {
          const msg = JSON.parse(messageRaw.toString());
          await this.handleClientMessage(ws, msg);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'INVALID_JSON_PAYLOAD' }));
        }
      });

      ws.on('close', () => {
        this.cleanupSocket(ws);
      });

      ws.on('error', (err) => {
        console.error('[WS Gateway] Client socket error:', err.message);
        this.cleanupSocket(ws);
      });

      ws.send(JSON.stringify({
        type: 'CONNECTED',
        authenticated: ws.traderId !== null,
        traderId: ws.traderId,
        username: ws.username,
        role: ws.role,
        timestamp: new Date().toISOString()
      }));
    });

    console.log('[WS Gateway] WebSocket Gateway initialized on /ws');
  }

  authenticateSocket(ws, token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      ws.traderId = decoded.id;
      ws.username = decoded.username;
      ws.role = decoded.role || 'TRADER';

      if (!this.traderSockets.has(ws.traderId)) {
        this.traderSockets.set(ws.traderId, new Set());
      }
      this.traderSockets.get(ws.traderId).add(ws);

      this.subscribe(ws, `trader:${ws.traderId}`);
      this.subscribe(ws, `piq:${ws.traderId}`);

      if (ws.role === 'ADMIN') {
        this.subscribe(ws, 'admin:alerts');
      }

      return true;
    } catch {
      ws.traderId = null;
      ws.username = null;
      ws.role = 'TRADER';
      return false;
    }
  }

  async handleClientMessage(ws, msg) {
    const { action, room, token } = msg;

    if (action === 'AUTH' && token) {
      const success = this.authenticateSocket(ws, token);
      return ws.send(JSON.stringify({
        type: 'AUTH_RESULT',
        success,
        traderId: ws.traderId,
        username: ws.username,
        role: ws.role
      }));
    }

    if (action === 'SUBSCRIBE' && room) {
      if (room.startsWith('piq:') || room.startsWith('trader:')) {
        const targetTraderId = room.split(':')[1];
        // Allow if socket is ADMIN or matching trader
        if (ws.role !== 'ADMIN' && (!ws.traderId || ws.traderId !== targetTraderId)) {
          return ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'UNAUTHORIZED_PRIVATE_ROOM_SUBSCRIPTION'
          }));
        }
      }

      this.subscribe(ws, room);
      return ws.send(JSON.stringify({ type: 'SUBSCRIBED', room }));
    }

    if (action === 'UNSUBSCRIBE' && room) {
      this.unsubscribe(ws, room);
      return ws.send(JSON.stringify({ type: 'UNSUBSCRIBED', room }));
    }

    if (action === 'PING') {
      return ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
    }

    // NATIVE WEBSOCKET ORDER ENTRY
    if (action === 'PLACE_ORDER') {
      if (!ws.traderId) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'UNAUTHENTICATED_SOCKET' }));
      }

      const { instrument, side, type, price, qty, tif, traderId: customTraderId } = msg;

      // Identity derivation: Admin can specify target traderId; normal traders cannot spoof
      const effectiveTraderId = (ws.role === 'ADMIN' && customTraderId) ? customTraderId : ws.traderId;

      if (!instrument || !side || !qty || !VALID_INSTRUMENTS.includes(instrument)) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'INVALID_ORDER_PARAMETERS' }));
      }

      const orderQty = parseInt(qty, 10);
      if (isNaN(orderQty) || orderQty <= 0) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'QUANTITY_MUST_BE_POSITIVE' }));
      }

      const orderType = type || 'LIMIT';
      const orderPrice = orderType === 'LIMIT' ? Number(price) : null;
      if (orderType === 'LIMIT' && (isNaN(orderPrice) || orderPrice <= 0)) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'VALID_PRICE_REQUIRED_FOR_LIMIT' }));
      }

      const orderId = `ord-${crypto.randomUUID()}`;
      const orderTif = tif || 'DAY';
      const timestamp = new Date().toISOString();

      await db.query(`
        INSERT INTO orders (id, trader_id, instrument, side, type, price, qty, filled_qty, status, tif, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'SUBMITTED', $8, $9, $9)
      `, [orderId, effectiveTraderId, instrument, side, orderType, orderPrice, orderQty, orderTif, timestamp]);

      if (this.producer) {
        await this.producer.send({
          topic: 'orders',
          messages: [{
            key: instrument,
            value: JSON.stringify({
              id: orderId,
              traderId: effectiveTraderId,
              instrument,
              side,
              type: orderType,
              price: orderPrice,
              qty: orderQty,
              tif: orderTif,
              timestamp
            })
          }]
        });
      }

      return ws.send(JSON.stringify({
        type: 'ORDER_SUBMITTED',
        orderId,
        traderId: effectiveTraderId,
        instrument,
        side,
        price: orderPrice,
        qty: orderQty,
        timestamp
      }));
    }

    // NATIVE WEBSOCKET ORDER CANCELLATION
    if (action === 'CANCEL_ORDER') {
      if (!ws.traderId) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'UNAUTHENTICATED_SOCKET' }));
      }

      const { orderId, instrument } = msg;
      if (!orderId || !instrument) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'ORDER_ID_AND_INSTRUMENT_REQUIRED' }));
      }

      // 1. Update status to 'CANCELLED' in database (Admin or Owner)
      let updateResult;
      if (ws.role === 'ADMIN') {
        updateResult = await db.query(`
          UPDATE orders 
          SET status = 'CANCELLED', updated_at = NOW() 
          WHERE id = $1
          RETURNING id, trader_id;
        `, [orderId]);
      } else {
        updateResult = await db.query(`
          UPDATE orders 
          SET status = 'CANCELLED', updated_at = NOW() 
          WHERE id = $1 AND trader_id = $2
          RETURNING id, trader_id;
        `, [orderId, ws.traderId]);
      }

      if (updateResult.rows.length === 0) {
        return ws.send(JSON.stringify({ type: 'ERROR', message: 'ORDER_NOT_FOUND_OR_UNAUTHORIZED' }));
      }

      const targetTraderId = updateResult.rows[0].trader_id || ws.traderId;

      // 2. Publish CANCEL action to Kafka
      if (this.producer) {
        await this.producer.send({
          topic: 'orders',
          messages: [{
            key: instrument,
            value: JSON.stringify({
              action: 'CANCEL',
              orderId,
              traderId: targetTraderId,
              instrument,
              timestamp: new Date().toISOString()
            })
          }]
        });
      }

      return ws.send(JSON.stringify({
        type: 'CANCELLED',
        orderId,
        traderId: targetTraderId,
        instrument
      }));
    }
  }

  subscribe(ws, room) {
    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Set());
    }
    this.rooms.get(room).add(ws);
    ws.subscriptions.add(room);
  }

  unsubscribe(ws, room) {
    if (this.rooms.has(room)) {
      this.rooms.get(room).delete(ws);
      if (this.rooms.get(room).size === 0) {
        this.rooms.delete(room);
      }
    }
    ws.subscriptions.delete(room);
  }

  broadcastToRoom(room, data) {
    const clients = this.rooms.get(room);
    if (!clients || clients.size === 0) return 0;

    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    let sentCount = 0;

    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        sentCount++;
      }
    }
    return sentCount;
  }

  broadcastToTrader(traderId, data) {
    return this.broadcastToRoom(`trader:${traderId}`, data);
  }

  broadcastToAdmins(data) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    let sentCount = 0;
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws.role === 'ADMIN') {
        ws.send(payload);
        sentCount++;
      }
    }
    return sentCount;
  }

  cleanupSocket(ws) {
    for (const room of ws.subscriptions) {
      this.unsubscribe(ws, room);
    }
    if (ws.traderId && this.traderSockets.has(ws.traderId)) {
      this.traderSockets.get(ws.traderId).delete(ws);
      if (this.traderSockets.get(ws.traderId).size === 0) {
        this.traderSockets.delete(ws.traderId);
      }
    }
  }

  pruneDeadConnections() {
    this.wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        this.cleanupSocket(ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close(() => {
        resolve();
      });
    });
  }
}

module.exports = WebSocketGateway;