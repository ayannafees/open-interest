-- ============================================================================
-- Open Interest — Initial Seed Data
-- File: init-db/03_seed.sql
-- ============================================================================

-- 1. Seed Traders & Admin Accounts
INSERT INTO traders (id, username, password_hash, role)
VALUES
    ('admin_1', 'admin', '$2a$10$RMpqv7.QYIu1uZ29d90TUO18IXEYy9jx9BFmj3l3m2jQ1m8AkoQBm', 'ADMIN'),
    ('trader1', 'trader1', '$2a$10$aPHWZToLLGET6jZlztMumeGLp0ufDZTJdoWQp8PD2Xt5CfO7uqega', 'TRADER'),
    ('trader2', 'trader2', '$2a$10$c.GIO90.6nRH1UCVxjXX.OhZJJJyGky7GeqXJsAYKp5ER/HuRTsPy', 'TRADER')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;

-- 2. Seed Pre-loaded Instruments (5 Global Futures Contracts)
INSERT INTO instruments (symbol, description, exchange, family, tick_size, lot_size, start_price)
VALUES
    ('GC Dec27',  'Gold Futures Dec 2027',                  'COMEX', 'GC',  0.10000, 1, 2650.00000),
    ('CL Dec27',  'Crude Oil Futures Dec 2027',              'NYMEX', 'CL',  0.01000, 1, 78.50000),
    ('SR3 Dec27', '3-Month SOFR Futures Dec 2027',          'CME',   'SR3', 0.00500, 1, 96.03500),
    ('CRA Dec27', 'CORRA Rate Futures Dec 2027',            'MX',    'CRA', 0.00500, 1, 95.82000),
    ('ER3 Jun26', 'Euro Short-Term Rate Futures Jun 2026',  'ICE',   'ER3', 0.00500, 1, 97.21000)
ON CONFLICT (symbol) DO NOTHING;

-- 3. Seed Default Risk Limits for All Traders & Instruments
INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, trade_allowed, limit_version)
SELECT 
    t.id AS trader_id,
    i.symbol AS instrument,
    100 AS max_long,
    100 AS max_short,
    50 AS max_order_qty_outrights,
    100 AS max_order_qty_spreads,
    TRUE AS trade_allowed,
    1 AS limit_version
FROM traders t
CROSS JOIN instruments i
ON CONFLICT (trader_id, instrument) DO NOTHING;

-- 4. Seed Initial Flat Positions for All Traders & Instruments
INSERT INTO positions (trader_id, instrument, sod_pos, sod_px, buy_qty, sell_qty, net_pos, avg_px, realized_pl)
SELECT 
    t.id AS trader_id,
    i.symbol AS instrument,
    0 AS sod_pos,
    0 AS sod_px,
    0 AS buy_qty,
    0 AS sell_qty,
    0 AS net_pos,
    0 AS avg_px,
    0 AS realized_pl
FROM traders t
CROSS JOIN instruments i
ON CONFLICT (trader_id, instrument) DO NOTHING;