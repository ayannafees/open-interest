require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const db = require('../db.js');
const { authenticateToken } = require('./auth.js');

const router = express.Router();
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:4002';

// 5 Active Global Futures Contracts
const VALID_INSTRUMENTS = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];

/**
 * Factory Function: Injects Kafka Producer into the Express Trading Router
 * @param {Object} kafkaProducer - KafkaJS producer instance
 */
function createTradingRouter(kafkaProducer) {

  // All trading routes require valid JWT Authentication!
  router.use(authenticateToken);

  /**
   * Helper to derive effective traderId:
   * Non-admins CANNOT spoof or supply another traderId.
   * Admins can simulate/view another trader by specifying traderId.
   */
  function getEffectiveTraderId(req) {
    if (req.user.role === 'ADMIN') {
      return req.body?.traderId || req.query?.traderId || req.user.id;
    }
    return req.user.id;
  }

  /**
   * ============================================================================
   * 1. POST /api/trading/order
   * ============================================================================
   * Submits a new Limit or Market order:
   * - Validates parameters (Instrument, Side, Price, Qty)
   * - Derives traderId securely (tamper-proof for TRADER role)
   * - Synchronously evaluates Pre-Trade Risk Firewall (ROM) on Platform (Port 4002)
   * - If Rejected -> Returns immediate HTTP 400 Bad Request with rejection reason
   * - If Approved -> Persists to Postgres 'orders' table & dispatches to Kafka
   * - Returns HTTP 202 Accepted
   */
  router.post('/order', async (req, res) => {
    try {
      const { instrument, side, type, price, qty, tif } = req.body;
      const traderId = getEffectiveTraderId(req);

      // A. Input Validations
      if (!instrument || !side || !qty) {
        return res.status(400).json({ error: 'Instrument, side, and qty are required' });
      }

      if (!VALID_INSTRUMENTS.includes(instrument)) {
        return res.status(400).json({ error: `Invalid instrument: '${instrument}'` });
      }

      if (side !== 'BUY' && side !== 'SELL') {
        return res.status(400).json({ error: "Side must be 'BUY' or 'SELL'" });
      }

      const orderQty = parseInt(qty, 10);
      if (isNaN(orderQty) || orderQty <= 0) {
        return res.status(400).json({ error: 'Quantity must be a positive integer' });
      }

      const orderType = type || 'LIMIT';
      const orderPrice = orderType === 'LIMIT' ? Number(price) : null;
      if (orderType === 'LIMIT' && (isNaN(orderPrice) || orderPrice <= 0)) {
        return res.status(400).json({ error: 'Valid price is required for LIMIT orders' });
      }

      const orderId = `ord-${crypto.randomUUID()}`;
      const orderTif = tif || 'DAY';
      const timestamp = new Date().toISOString();

      // B. Synchronous Pre-Trade Risk Firewall Check (Platform Port 4002)
      try {
        const riskCheckRes = await fetch(`${PLATFORM_URL}/order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId,
            traderId,
            instrument,
            side,
            type: orderType,
            price: orderPrice,
            qty: orderQty,
            tif: orderTif
          })
        });

        if (riskCheckRes.ok) {
          const riskResult = await riskCheckRes.json();

          // 💥 IMMEDIATE SYNCHRONOUS REJECTION!
          if (riskResult.status === 'REJECTED') {
            await db.query(`
              INSERT INTO orders (id, trader_id, instrument, side, type, price, qty, filled_qty, status, tif, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'REJECTED', $8, $9, $9)
            `, [orderId, traderId, instrument, side, orderType, orderPrice, orderQty, orderTif, timestamp]).catch(() => { });

            return res.status(400).json({
              status: 'REJECTED',
              orderId,
              reason: riskResult.reason,
              message: `Order rejected by Pre-Trade Risk Firewall: ${riskResult.reason}`
            });
          }
        }
      } catch {
        // Fallback: If Platform HTTP gateway is not directly reachable, proceed to Kafka
      }

      // C. Persist approved order audit record in Postgres 'orders' table
      await db.query(`
        INSERT INTO orders (id, trader_id, instrument, side, type, price, qty, filled_qty, status, tif, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'SUBMITTED', $8, $9, $9)
      `, [orderId, traderId, instrument, side, orderType, orderPrice, orderQty, orderTif, timestamp]);

      // D. Publish to Kafka 'orders' topic (Keyed by instrument for FIFO ordering)
      if (kafkaProducer) {
        await kafkaProducer.send({
          topic: 'orders',
          messages: [{
            key: instrument,
            value: JSON.stringify({
              id: orderId,
              traderId,
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

      // Return HTTP 202 Accepted
      res.status(202).json({
        status: 'SUBMITTED',
        orderId,
        instrument,
        side,
        qty: orderQty,
        price: orderPrice,
        timestamp
      });
    } catch (err) {
      console.error('[Trading Error] POST /order failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 2. DELETE /api/trading/order/:orderId
   * ============================================================================
   * Cancels an active working order:
   * - Enforces ownership (or Admin override)
   * - Immediately updates status to 'CANCELLED' in PostgreSQL
   * - Publishes CANCEL command to Kafka
   */
  router.delete('/order/:orderId', async (req, res) => {
    try {
      const { orderId } = req.params;
      const { instrument } = req.body;
      const traderId = getEffectiveTraderId(req);

      if (!instrument) {
        return res.status(400).json({ error: 'Instrument is required in request body' });
      }

      let updateResult;
      if (req.user.role === 'ADMIN') {
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
        `, [orderId, traderId]);
      }

      if (updateResult.rows.length === 0) {
        return res.status(404).json({ error: 'ORDER_NOT_FOUND_OR_UNAUTHORIZED' });
      }

      const cancelledTraderId = updateResult.rows[0].trader_id || traderId;

      // 2. Publish CANCEL action to Kafka
      if (kafkaProducer) {
        await kafkaProducer.send({
          topic: 'orders',
          messages: [{
            key: instrument,
            value: JSON.stringify({
              action: 'CANCEL',
              orderId,
              traderId: cancelledTraderId,
              instrument,
              timestamp: new Date().toISOString()
            })
          }]
        });
      }

      res.json({
        status: 'CANCELLED',
        orderId,
        instrument
      });
    } catch (err) {
      console.error('[Trading Error] DELETE /order failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 3. GET /api/trading/orders
   * ============================================================================
   * Queries active working & submitted orders from Postgres
   */
  router.get('/orders', async (req, res) => {
    try {
      const traderId = getEffectiveTraderId(req);

      const result = await db.query(`
        SELECT 
          id, 
          trader_id AS "traderId",
          instrument, 
          side, 
          type, 
          price::float AS price, 
          qty, 
          COALESCE(filled_qty, 0) AS "filledQty", 
          GREATEST(0, qty - COALESCE(filled_qty, 0)) AS "remainingQty",
          status, 
          tif, 
          created_at AS "createdAt", 
          updated_at AS "updatedAt"
        FROM orders
        WHERE trader_id = $1
        ORDER BY created_at DESC
        LIMIT 300
      `, [traderId]);

      res.json(result.rows);
    } catch (err) {
      console.error('[Trading Error] GET /orders failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 4. GET /api/trading/trades
   * ============================================================================
   * Queries all historical executed fills from TimescaleDB
   */
  router.get('/trades', async (req, res) => {
    try {
      const traderId = getEffectiveTraderId(req);

      // 1. Query trades table (execution matches)
      const tradesResult = await db.query(`
        SELECT 
          id, 
          instrument, 
          price, 
          qty, 
          aggressor_side AS "aggressorSide",
          buyer_id AS "buyerId",
          seller_id AS "sellerId",
          CASE 
            WHEN buyer_id = $1 THEN 'BUY'
            WHEN seller_id = $1 THEN 'SELL'
            ELSE 'BUY'
          END AS side,
          time
        FROM trades
        WHERE buyer_id = $1 OR seller_id = $1
        ORDER BY time DESC
        LIMIT 200
      `, [traderId]).catch(() => ({ rows: [] }));

      // 2. Query orders table for filled/partially filled orders as fallback fills
      const filledOrdersResult = await db.query(`
        SELECT id, instrument, side, price, filled_qty AS qty, updated_at AS time
        FROM orders
        WHERE trader_id = $1 AND (status = 'FILLED' OR filled_qty > 0)
        ORDER BY updated_at DESC
        LIMIT 200
      `, [traderId]).catch(() => ({ rows: [] }));

      const seenKeys = new Set();
      const allFills = [];

      for (const row of tradesResult.rows) {
        const isBuyer = row.buyerId === traderId;
        const isSeller = row.sellerId === traderId;
        const traderSide = isBuyer ? 'BUY' : isSeller ? 'SELL' : (row.side || 'BUY');
        const key = `${row.id}`;
        seenKeys.add(key);

        allFills.push({
          id: row.id,
          orderId: row.id,
          traderId,
          buyerId: row.buyerId,
          sellerId: row.sellerId,
          instrument: row.instrument,
          side: traderSide,
          userSide: traderSide,
          price: parseFloat(row.price),
          qty: parseInt(row.qty, 10),
          aggressorSide: row.aggressorSide || traderSide,
          time: new Date(row.time).toISOString()
        });
      }

      for (const row of filledOrdersResult.rows) {
        const key = `ord_${row.id}`;
        if (!seenKeys.has(row.id) && !seenKeys.has(key)) {
          seenKeys.add(key);
          allFills.push({
            id: key,
            orderId: row.id,
            traderId,
            buyerId: row.side === 'BUY' ? traderId : 'MARKET_MAKER',
            sellerId: row.side === 'SELL' ? traderId : 'MARKET_MAKER',
            instrument: row.instrument,
            side: row.side,
            userSide: row.side,
            price: parseFloat(row.price || 0),
            qty: parseInt(row.qty || 1, 10),
            aggressorSide: row.side,
            time: new Date(row.time).toISOString()
          });
        }
      }

      allFills.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

      res.json(allFills);
    } catch (err) {
      console.error('[Trading Error] GET /trades failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 5. GET /api/trading/positions
   * ============================================================================
   * Queries real-time Net Positions across all 5 instruments from Platform ROM / DB
   */
  router.get('/positions', async (req, res) => {
    try {
      const traderId = getEffectiveTraderId(req);
      const positions = [];

      for (const inst of VALID_INSTRUMENTS) {
        let posData = null;
        try {
          const platRes = await fetch(`${PLATFORM_URL}/risk/position/${traderId}/${encodeURIComponent(inst)}`);
          if (platRes.ok) {
            const p = await platRes.json();
            posData = {
              traderId,
              instrument: inst,
              netPos: p.netPos || 0,
              avgPx: p.avgPx || 0,
              realizedPl: p.realizedPnl || p.realizedPl || 0,
              buyQty: p.buyQty || 0,
              sellQty: p.sellQty || 0,
              workingBuys: p.workingBuys || 0,
              workingSells: p.workingSells || 0,
            };
          }
        } catch { }

        if (!posData) {
          const dbPos = await db.query(
            'SELECT net_pos, avg_px, realized_pl, buy_qty, sell_qty FROM positions WHERE trader_id = $1 AND instrument = $2',
            [traderId, inst]
          );

          if (dbPos.rows.length > 0) {
            const row = dbPos.rows[0];
            posData = {
              traderId,
              instrument: inst,
              netPos: parseInt(row.net_pos, 10) || 0,
              avgPx: parseFloat(row.avg_px) || 0,
              realizedPl: parseFloat(row.realized_pl) || 0,
              buyQty: parseInt(row.buy_qty, 10) || 0,
              sellQty: parseInt(row.sell_qty, 10) || 0,
              workingBuys: 0,
              workingSells: 0,
              source: 'DATABASE_PERSISTENCE'
            };
          } else {
            posData = {
              traderId,
              instrument: inst,
              netPos: 0,
              avgPx: 0,
              realizedPl: 0,
              buyQty: 0,
              sellQty: 0,
              workingBuys: 0,
              workingSells: 0
            };
          }
        }

        positions.push(posData);
      }

      res.json(positions);
    } catch (err) {
      console.error('[Trading Error] GET /positions failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 6. GET /api/trading/limits
   * ============================================================================
   * Queries active contract limits from Platform ROM / PostgreSQL for the caller
   */
  router.get('/limits', async (req, res) => {
    try {
      const traderId = getEffectiveTraderId(req);

      // Try Platform ROM first
      try {
        const platRes = await fetch(`${PLATFORM_URL}/risk/limits/${encodeURIComponent(traderId)}`);
        if (platRes.ok) {
          const platData = await platRes.json();
          if (platData && Array.isArray(platData.limits) && platData.limits.length > 0) {
            return res.json(platData);
          }
        }
      } catch { }

      // Fallback to PostgreSQL risk_limits table
      const dbRes = await db.query(
        `SELECT instrument, max_long AS "maxPosition", max_order_qty_outrights AS "maxOrderQty",
                COALESCE(max_notional, 0) AS "maxNotional", trade_allowed AS "tradeAllowed"
         FROM risk_limits WHERE trader_id = $1`,
        [traderId]
      );

      const dbMap = new Map();
      dbRes.rows.forEach(r => dbMap.set(r.instrument, r));

      const limits = VALID_INSTRUMENTS.map(inst => {
        const found = dbMap.get(inst);
        if (found) {
          return {
            instrument: inst,
            maxOrderQty: parseInt(found.maxOrderQty, 10) || 0,
            maxPosition: parseInt(found.maxPosition, 10) || 0,
            maxNotional: parseFloat(found.maxNotional) || 0,
            tradeAllowed: Boolean(found.tradeAllowed)
          };
        }
        return {
          instrument: inst,
          maxOrderQty: 0,
          maxPosition: 0,
          maxNotional: 0,
          tradeAllowed: false
        };
      });

      res.json({ traderId, limits });
    } catch (err) {
      console.error('[Trading Error] GET /limits failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 7. POST /api/trading/limits
   * ============================================================================
   * Configures Pre-Trade Risk Limits (Admin only; Traders must request increase)
   */
  router.post('/limits', async (req, res) => {
    try {
      if (req.user.role !== 'ADMIN') {
        return res.status(403).json({
          error: 'FORBIDDEN_LIMIT_MODIFICATION',
          message: 'Traders cannot modify risk limits directly. Please submit a limit-increase request for administrator approval.'
        });
      }

      const traderId = getEffectiveTraderId(req);
      const { instrument, maxOrderQty, maxPosition, maxNotional, tradeAllowed } = req.body;

      if (!instrument) {
        return res.status(400).json({ error: 'Instrument is required' });
      }

      const parsedOrderQty = parseInt(maxOrderQty, 10) || 0;
      const parsedPosition = parseInt(maxPosition, 10) || 0;
      const parsedNotional = parseFloat(maxNotional) || 0;
      const isTradeAllowed = tradeAllowed !== undefined ? Boolean(tradeAllowed) : (parsedOrderQty > 0 && parsedPosition > 0);

      try {
        await fetch(`${PLATFORM_URL}/risk/limits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            traderId,
            instrument,
            maxOrderQty: parsedOrderQty,
            maxPosition: parsedPosition,
            maxNotional: parsedNotional,
          }),
        });
      } catch (err) {
        console.warn('[Platform Limits Update Failed]', err.message);
      }

      await db.query(`
        INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, trade_allowed, limit_version)
        VALUES ($1, $2, $3, $3, $4, $4, $5, 1)
        ON CONFLICT (trader_id, instrument) DO UPDATE SET
            max_long = EXCLUDED.max_long,
            max_short = EXCLUDED.max_short,
            max_order_qty_outrights = EXCLUDED.max_order_qty_outrights,
            max_order_qty_spreads = EXCLUDED.max_order_qty_spreads,
            trade_allowed = EXCLUDED.trade_allowed;
      `, [traderId, instrument, parsedPosition, parsedOrderQty, isTradeAllowed]);

      res.json({
        status: 'UPDATED',
        traderId,
        instrument,
        maxOrderQty: parsedOrderQty,
        maxPosition: parsedPosition,
        maxNotional: parsedNotional,
        tradeAllowed: isTradeAllowed,
      });
    } catch (err) {
      console.error('[Trading Error] POST /limits failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 7. POST /api/trading/limit-requests
   * ============================================================================
   * Allows traders to request a limit increase for administrative review.
   */
  router.post('/limit-requests', async (req, res) => {
    try {
      const traderId = req.user.id;
      const { instrument, reqMaxOrderQty, reqMaxPosition, reqMaxNotional, reason } = req.body;

      if (!instrument || !VALID_INSTRUMENTS.includes(instrument)) {
        return res.status(400).json({ error: `Valid instrument is required: ${VALID_INSTRUMENTS.join(', ')}` });
      }

      const orderQty = parseInt(reqMaxOrderQty, 10);
      const position = parseInt(reqMaxPosition, 10);
      const notional = parseFloat(reqMaxNotional);

      if (isNaN(orderQty) || orderQty <= 0) {
        return res.status(400).json({ error: 'Requested Max Order Qty must be a positive integer' });
      }
      if (isNaN(position) || position <= 0) {
        return res.status(400).json({ error: 'Requested Max Position must be a positive integer' });
      }
      if (isNaN(notional) || notional < 1000000) {
        return res.status(400).json({ error: 'Requested Max Notional must be at least $1,000,000 (1 Million USD)' });
      }

      const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
      const result = await db.query(`
        INSERT INTO limit_requests (id, trader_id, instrument, requested_max_order_qty, requested_max_position, requested_max_notional, reason, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
        RETURNING id, trader_id AS "traderId", instrument, requested_max_order_qty AS "reqMaxOrderQty",
                  requested_max_position AS "reqMaxPosition", requested_max_notional AS "reqMaxNotional",
                  reason, status, created_at AS "createdAt";
      `, [requestId, traderId, instrument, orderQty, position, notional, reason || 'Trader requested limit increase']);

      const inserted = result.rows[0];
      const gateway = req.app?.get('gateway');
      if (gateway) {
        gateway.broadcastToAdmins({
          type: 'LIMIT_REQUEST_ALERT',
          request: {
            ...inserted,
            username: req.user.username
          },
          timestamp: new Date().toISOString()
        });
      }

      res.status(201).json({
        status: 'SUBMITTED',
        request: inserted
      });
    } catch (err) {
      console.error('[Trading Error] POST /limit-requests failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  /**
   * ============================================================================
   * 8. GET /api/trading/limit-requests
   * ============================================================================
   * Returns list of limit increase requests submitted by the calling trader.
   */
  router.get('/limit-requests', async (req, res) => {
    try {
      const traderId = getEffectiveTraderId(req);

      const result = await db.query(`
        SELECT id, trader_id AS "traderId", instrument, requested_max_order_qty AS "reqMaxOrderQty",
               requested_max_position AS "reqMaxPosition", requested_max_notional AS "reqMaxNotional",
               reason, status, created_at AS "createdAt", reviewed_at AS "reviewedAt",
               reviewed_by AS "reviewedBy", admin_comment AS "adminComment"
        FROM limit_requests
        WHERE trader_id = $1
        ORDER BY created_at DESC
      `, [traderId]);

      res.json(result.rows);
    } catch (err) {
      console.error('[Trading Error] GET /limit-requests failed:', err.message);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });

  return router;
}

module.exports = createTradingRouter;