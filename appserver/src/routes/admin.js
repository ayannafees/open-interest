require('dotenv').config();
const express = require('express');
const db = require('../db.js');
const { authenticateToken, requireAdmin } = require('./auth.js');

const router = express.Router();
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:4002';
const EXCHANGE_URL = process.env.EXCHANGE_URL || 'http://localhost:4001';

// All admin routes require valid authentication and strict ADMIN role
router.use(authenticateToken);
router.use(requireAdmin);

/**
 * ============================================================================
 * 1. GET /api/admin/traders
 * ============================================================================
 * Returns list of all accounts for the admin trader switcher and monitoring.
 */
router.get('/traders', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, username, role, created_at FROM traders ORDER BY created_at ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[Admin Error] GET /traders failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 2. GET /api/admin/limits/:traderId
 * ============================================================================
 * Fetches risk limits configured for a specific trader.
 */
router.get('/limits/:traderId', async (req, res) => {
    try {
        const { traderId } = req.params;

        // Try querying Platform ROM first
        try {
            const platRes = await fetch(`${PLATFORM_URL}/risk/limits/${encodeURIComponent(traderId)}`);
            if (platRes.ok) {
                const platData = await platRes.json();
                if (platData && Array.isArray(platData.limits) && platData.limits.length > 0) {
                    return res.json(platData);
                }
            }
        } catch { }

        // Fallback to PostgreSQL
        const VALID_INSTRUMENTS = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];
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
        console.error('[Admin Error] GET /limits/:traderId failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 3. POST /api/admin/limits
 * ============================================================================
 * Directly configures/updates risk limits for any trader.
 */
router.post('/limits', async (req, res) => {
    try {
        const { traderId, instrument, maxOrderQty, maxPosition, maxNotional, tradeAllowed } = req.body;

        if (!traderId || !instrument) {
            return res.status(400).json({ error: 'traderId and instrument are required' });
        }

        const parsedOrderQty = parseInt(maxOrderQty, 10) || 0;
        const parsedPosition = parseInt(maxPosition, 10) || 0;
        const parsedNotional = parseFloat(maxNotional) || 0;
        const isTradeAllowed = tradeAllowed !== undefined ? Boolean(tradeAllowed) : (parsedOrderQty > 0 && parsedPosition > 0);

        // 1. Sync to Platform ROM Risk Engine
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
            console.warn('[Admin Limits] Platform ROM sync warning:', err.message);
        }

        // 2. Upsert PostgreSQL risk_limits table
        await db.query(`
            INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, max_notional, trade_allowed, limit_version)
            VALUES ($1, $2, $3, $3, $4, $4, $5, $6, 1)
            ON CONFLICT (trader_id, instrument) DO UPDATE SET
                max_long = EXCLUDED.max_long,
                max_short = EXCLUDED.max_short,
                max_order_qty_outrights = EXCLUDED.max_order_qty_outrights,
                max_order_qty_spreads = EXCLUDED.max_order_qty_spreads,
                max_notional = EXCLUDED.max_notional,
                trade_allowed = EXCLUDED.trade_allowed;
        `, [traderId, instrument, parsedPosition, parsedOrderQty, parsedNotional, isTradeAllowed]);

        // 3. Real-Time WebSocket broadcast to Trader and Admins
        const gateway = req.app.get('gateway');
        if (gateway) {
            const payload = {
                type: 'LIMITS_UPDATED',
                traderId,
                limits: [{
                    instrument,
                    maxOrderQty: parsedOrderQty,
                    maxPosition: parsedPosition,
                    maxNotional: parsedNotional,
                    tradeAllowed: isTradeAllowed,
                }],
                timestamp: new Date().toISOString()
            };
            gateway.broadcastToTrader(traderId, payload);
            gateway.broadcastToAdmins(payload);
        }

        res.json({
            status: 'SUCCESS',
            traderId,
            instrument,
            maxOrderQty: parsedOrderQty,
            maxPosition: parsedPosition,
            maxNotional: parsedNotional,
            tradeAllowed: isTradeAllowed,
        });
    } catch (err) {
        console.error('[Admin Error] POST /limits failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 4. GET /api/admin/limit-requests
 * ============================================================================
 * Lists all trader limit increase requests with status and details.
 */
router.get('/limit-requests', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT lr.id, lr.trader_id AS "traderId", t.username, lr.instrument, 
                   lr.requested_max_order_qty AS "reqMaxOrderQty", 
                   lr.requested_max_position AS "reqMaxPosition", 
                   lr.requested_max_notional AS "reqMaxNotional", 
                   lr.reason, lr.status, lr.created_at AS "createdAt", 
                   lr.reviewed_at AS "reviewedAt", lr.reviewed_by AS "reviewedBy", 
                   lr.admin_comment AS "adminComment"
            FROM limit_requests lr
            LEFT JOIN traders t ON lr.trader_id = t.id
            ORDER BY lr.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('[Admin Error] GET /limit-requests failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 5. POST /api/admin/limit-requests/:id/review
 * ============================================================================
 * Admin approves or rejects a trader's limit increase request.
 */
router.post('/limit-requests/:id/review', async (req, res) => {
    try {
        const { id } = req.params;
        const { action, adminComment } = req.body; // 'APPROVE' or 'REJECT'
        const adminId = req.user.id;

        if (action !== 'APPROVE' && action !== 'REJECT') {
            return res.status(400).json({ error: "Action must be 'APPROVE' or 'REJECT'" });
        }

        const reqQuery = await db.query(
            'SELECT * FROM limit_requests WHERE id = $1',
            [id]
        );

        if (reqQuery.rows.length === 0) {
            return res.status(404).json({ error: 'LIMIT_REQUEST_NOT_FOUND' });
        }

        const limitReq = reqQuery.rows[0];
        if (limitReq.status !== 'PENDING') {
            return res.status(400).json({ error: `Request already reviewed (status: ${limitReq.status})` });
        }

        const nextStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';

        // If APPROVED, apply limits to Platform ROM and Postgres
        if (action === 'APPROVE') {
            const { trader_id, instrument, requested_max_order_qty, requested_max_position, requested_max_notional } = limitReq;
            const parsedOrderQty = parseInt(requested_max_order_qty, 10) || 0;
            const parsedPosition = parseInt(requested_max_position, 10) || 0;
            const parsedNotional = parseFloat(requested_max_notional) || 0;

            try {
                await fetch(`${PLATFORM_URL}/risk/limits`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        traderId: trader_id,
                        instrument,
                        maxOrderQty: parsedOrderQty,
                        maxPosition: parsedPosition,
                        maxNotional: parsedNotional,
                    }),
                });
            } catch (err) {
                console.warn('[Admin Review] Platform ROM sync warning:', err.message);
            }

            await db.query(`
                INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, max_notional, trade_allowed, limit_version)
                VALUES ($1, $2, $3, $3, $4, $4, $5, TRUE, 1)
                ON CONFLICT (trader_id, instrument) DO UPDATE SET
                    max_long = EXCLUDED.max_long,
                    max_short = EXCLUDED.max_short,
                    max_order_qty_outrights = EXCLUDED.max_order_qty_outrights,
                    max_order_qty_spreads = EXCLUDED.max_order_qty_spreads,
                    max_notional = EXCLUDED.max_notional,
                    trade_allowed = TRUE;
            `, [trader_id, instrument, parsedPosition, parsedOrderQty, parsedNotional]);

            // Broadcast real-time LIMITS_UPDATED event to trader and admins
            const gateway = req.app.get('gateway');
            if (gateway) {
                const payload = {
                    type: 'LIMITS_UPDATED',
                    traderId: trader_id,
                    limits: [{
                        instrument,
                        maxOrderQty: parsedOrderQty,
                        maxPosition: parsedPosition,
                        maxNotional: parsedNotional,
                        tradeAllowed: true,
                    }],
                    requestId: id,
                    timestamp: new Date().toISOString()
                };
                gateway.broadcastToTrader(trader_id, payload);
                gateway.broadcastToAdmins(payload);
            }
        }

        // Update limit_requests record
        const updateRes = await db.query(`
            UPDATE limit_requests
            SET status = $1, reviewed_by = $2, reviewed_at = NOW(), admin_comment = $3
            WHERE id = $4
            RETURNING *;
        `, [nextStatus, adminId, adminComment || null, id]);

        res.json({
            status: 'SUCCESS',
            request: updateRes.rows[0],
        });
    } catch (err) {
        console.error('[Admin Error] POST /limit-requests/:id/review failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 6. GET /api/admin/market-mode
 * ============================================================================
 * Fetches current market data simulation mode from Exchange (Port 4001).
 */
router.get('/market-mode', async (req, res) => {
    try {
        const exchangeRes = await fetch(`${EXCHANGE_URL}/admin/mds/mode`);
        if (exchangeRes.ok) {
            const data = await exchangeRes.json();
            return res.json(data);
        }
        res.status(exchangeRes.status).json({ error: 'FAILED_TO_FETCH_MDS_MODE' });
    } catch (err) {
        console.error('[Admin Error] GET /market-mode failed:', err.message);
        res.status(500).json({ error: 'EXCHANGE_UNREACHABLE', message: err.message });
    }
});

/**
 * ============================================================================
 * 7. POST /api/admin/market-mode
 * ============================================================================
 * Updates market data simulation mode on Exchange ('RANDOM_WALK' vs 'USER_DRIVEN').
 */
router.post('/market-mode', async (req, res) => {
    try {
        const { mode } = req.body;
        if (mode !== 'RANDOM_WALK' && mode !== 'USER_DRIVEN') {
            return res.status(400).json({
                error: "Invalid mode. Must be either 'RANDOM_WALK' or 'USER_DRIVEN'"
            });
        }

        const exchangeRes = await fetch(`${EXCHANGE_URL}/admin/mds/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });

        if (!exchangeRes.ok) {
            const errData = await exchangeRes.json().catch(() => ({}));
            return res.status(exchangeRes.status).json(errData);
        }

        const data = await exchangeRes.json();
        const gateway = req.app.get('gateway');
        if (gateway) {
            gateway.broadcastToAdmins({
                type: 'MARKET_MODE_CHANGED',
                mode: data.activeMode || mode,
                timestamp: new Date().toISOString()
            });
        }

        res.json(data);
    } catch (err) {
        console.error('[Admin Error] POST /market-mode failed:', err.message);
        res.status(500).json({ error: 'EXCHANGE_UNREACHABLE', message: err.message });
    }
});

module.exports = router;

