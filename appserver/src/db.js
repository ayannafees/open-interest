const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// 1. Create a Pool instance connecting to pgBouncer on port 6432
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PGBOUNCER_PORT || '6432', 10),
    database: process.env.POSTGRES_DB || 'open_interest',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    console.error('[DB Pool] Unexpected error on idle client:', err.message);
});

async function initDb() {
    try {
        await pool.query(`
            ALTER TABLE traders ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'TRADER';
            ALTER TABLE risk_limits ADD COLUMN IF NOT EXISTS max_notional NUMERIC(14, 2) DEFAULT 0;
        `).catch(() => {});

        await pool.query(`
            CREATE TABLE IF NOT EXISTS limit_requests (
                id VARCHAR(64) PRIMARY KEY,
                trader_id VARCHAR(64) NOT NULL REFERENCES traders(id),
                instrument VARCHAR(32) NOT NULL,
                current_max_order_qty INTEGER DEFAULT 0,
                current_max_position INTEGER DEFAULT 0,
                current_max_notional NUMERIC(14, 2) DEFAULT 0,
                requested_max_order_qty INTEGER NOT NULL,
                requested_max_position INTEGER NOT NULL,
                requested_max_notional NUMERIC(14, 2) NOT NULL,
                reason TEXT NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
                created_at TIMESTAMPTZ DEFAULT NOW(),
                reviewed_at TIMESTAMPTZ,
                reviewed_by VARCHAR(64),
                admin_comment TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_limit_requests_trader ON limit_requests (trader_id, status);
            CREATE INDEX IF NOT EXISTS idx_limit_requests_status ON limit_requests (status, created_at DESC);
        `).catch(() => {});

        // Default seed accounts passwords from environment
        const adminPassword = process.env.ADMIN_PASSWORD || 'AdminDefaultDev2026!';
        const trader1Password = process.env.TRADER1_PASSWORD || 'Trader1DefaultDev2026!';
        const trader2Password = process.env.TRADER2_PASSWORD || 'Trader2DefaultDev2026!';

        const adminHash = await bcrypt.hash(adminPassword, 10);
        const trader1Hash = await bcrypt.hash(trader1Password, 10);
        const trader2Hash = await bcrypt.hash(trader2Password, 10);

        await pool.query(
            `INSERT INTO traders (id, username, password_hash, role)
             VALUES ('admin_1', 'admin', $1, 'ADMIN')
             ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
            [adminHash]
        ).catch(() => {});

        await pool.query(
            `INSERT INTO traders (id, username, password_hash, role)
             VALUES ('trader1', 'trader1', $1, 'TRADER')
             ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
            [trader1Hash]
        ).catch(() => {});

        await pool.query(
            `INSERT INTO traders (id, username, password_hash, role)
             VALUES ('trader2', 'trader2', $1, 'TRADER')
             ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
            [trader2Hash]
        ).catch(() => {});

        await pool.query(
            `UPDATE traders SET password_hash = $1 WHERE username = 'trader_1' OR id = 'trader_1'`,
            [trader1Hash]
        ).catch(() => {});

        await pool.query(
            `UPDATE traders SET password_hash = $1 WHERE username = 'trader_2' OR id = 'trader_2'`,
            [trader2Hash]
        ).catch(() => {});

        // Seed default limits and flat positions for seeded accounts
        await pool.query(`
            INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, trade_allowed, limit_version)
            SELECT t.id, i.symbol, 100, 100, 50, 100, TRUE, 1
            FROM traders t
            CROSS JOIN instruments i
            ON CONFLICT (trader_id, instrument) DO NOTHING;
        `).catch(() => {});

        await pool.query(`
            INSERT INTO positions (trader_id, instrument, sod_pos, sod_px, buy_qty, sell_qty, net_pos, avg_px, realized_pl)
            SELECT t.id, i.symbol, 0, 0, 0, 0, 0, 0, 0
            FROM traders t
            CROSS JOIN instruments i
            ON CONFLICT (trader_id, instrument) DO NOTHING;
        `).catch(() => {});

        console.log('[DB] ✅ Database RBAC schema & seed accounts verified');
    } catch (err) {
        console.warn('[DB Migration Warning]', err.message);
    }
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    initDb,
    pool
};