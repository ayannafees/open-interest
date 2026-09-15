const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

// 1. Create a Pool instance connecting to pgBouncer on port 6432 (fallback 5432)
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PGBOUNCER_PORT || process.env.DB_PORT || '6432', 10),
    database: process.env.POSTGRES_DB || 'open_interest',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    console.error('[Platform DB Pool] Unexpected error on idle client:', err.message);
});

async function query(text, params) {
    return pool.query(text, params);
}

async function loadAllLimits() {
    try {
        const res = await pool.query(
            `SELECT trader_id, instrument, max_long, max_short, 
                    max_order_qty_outrights, max_order_qty_spreads, 
                    COALESCE(max_notional, 10000000) AS max_notional, 
                    trade_allowed, limit_version 
             FROM risk_limits`
        );
        return res.rows;
    } catch (err) {
        console.warn('[Platform DB] loadAllLimits warning:', err.message);
        return [];
    }
}

async function loadAllPositions() {
    try {
        const res = await pool.query(
            `SELECT trader_id, instrument, sod_pos, sod_px, buy_qty, sell_qty, net_pos, avg_px, realized_pl 
             FROM positions`
        );
        return res.rows;
    } catch (err) {
        console.warn('[Platform DB] loadAllPositions warning:', err.message);
        return [];
    }
}

async function upsertLimit(traderId, instrument, limits) {
    try {
        const maxOrderQty = limits.maxOrderQty ?? limits.max_order_qty_outrights ?? 100;
        const maxPosition = limits.maxPosition ?? limits.max_long ?? 200;
        const maxNotional = limits.maxNotional ?? limits.max_notional ?? 10000000;
        const tradeAllowed = limits.tradeAllowed ?? limits.trade_allowed ?? true;

        await pool.query(`
            INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, max_notional, trade_allowed, limit_version)
            VALUES ($1, $2, $3, $3, $4, $4, $5, $6, 1)
            ON CONFLICT (trader_id, instrument) DO UPDATE SET
                max_long = EXCLUDED.max_long,
                max_short = EXCLUDED.max_short,
                max_order_qty_outrights = EXCLUDED.max_order_qty_outrights,
                max_order_qty_spreads = EXCLUDED.max_order_qty_spreads,
                max_notional = EXCLUDED.max_notional,
                trade_allowed = EXCLUDED.trade_allowed;
        `, [traderId, instrument, maxPosition, maxOrderQty, maxNotional, Boolean(tradeAllowed)]);
        return true;
    } catch (err) {
        console.warn(`[Platform DB] upsertLimit warning for ${traderId}:${instrument}:`, err.message);
        return false;
    }
}

async function upsertPosition(traderId, instrument, pos) {
    try {
        await pool.query(`
            INSERT INTO positions (trader_id, instrument, sod_pos, sod_px, buy_qty, sell_qty, net_pos, avg_px, realized_pl)
            VALUES ($1, $2, 0, 0, $3, $4, $5, $6, $7)
            ON CONFLICT (trader_id, instrument) DO UPDATE SET
                buy_qty = EXCLUDED.buy_qty,
                sell_qty = EXCLUDED.sell_qty,
                net_pos = EXCLUDED.net_pos,
                avg_px = EXCLUDED.avg_px,
                realized_pl = EXCLUDED.realized_pl;
        `, [
            traderId,
            instrument,
            pos.buyQty || 0,
            pos.sellQty || 0,
            pos.netPos || 0,
            pos.avgPx || 0,
            pos.realizedPnl || 0
        ]);
        return true;
    } catch (err) {
        console.warn(`[Platform DB] upsertPosition warning for ${traderId}:${instrument}:`, err.message);
        return false;
    }
}

module.exports = {
    pool,
    query,
    loadAllLimits,
    loadAllPositions,
    upsertLimit,
    upsertPosition
};
