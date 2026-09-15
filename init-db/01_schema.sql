-- ============================================================================
-- Open Interest — Core Relational Schema & Table Definitions
-- File: init-db/01_schema.sql
-- ============================================================================

-- Ensure clean state (useful during container rebuilds)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Traders Table (Authentication, User Identity & Role-Based Access Control)
CREATE TABLE IF NOT EXISTS traders (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'TRADER' CHECK (role IN ('ADMIN', 'TRADER')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Instruments Table (Market Definition & Contract Specs)
CREATE TABLE IF NOT EXISTS instruments (
    symbol VARCHAR(32) PRIMARY KEY,
    description VARCHAR(128) NOT NULL,
    exchange VARCHAR(32) NOT NULL,
    family VARCHAR(32) NOT NULL,
    tick_size NUMERIC(10, 5) NOT NULL,
    lot_size INTEGER DEFAULT 1,
    start_price NUMERIC(12, 5) NOT NULL
);

-- 3. Orders Table (Order Lifecycle & State Machine)
CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    trader_id VARCHAR(64) NOT NULL REFERENCES traders(id),
    instrument VARCHAR(32) NOT NULL REFERENCES instruments(symbol),
    side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    type VARCHAR(8) NOT NULL CHECK (type IN ('LIMIT', 'MARKET')),
    price NUMERIC(12, 5),
    qty INTEGER NOT NULL CHECK (qty > 0),
    filled_qty INTEGER DEFAULT 0 CHECK (filled_qty >= 0),
    status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING_RISK', 'SUBMITTED', 'WORKING', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED')),
    tif VARCHAR(8) NOT NULL CHECK (tif IN ('DAY', 'GTC', 'IOC', 'FOK')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Trades Table (Execution Records - Prepared for Hypertable Conversion)
CREATE TABLE IF NOT EXISTS trades (
    id VARCHAR(64) NOT NULL,
    buyer_id VARCHAR(64) NOT NULL,
    seller_id VARCHAR(64) NOT NULL,
    instrument VARCHAR(32) NOT NULL,
    price NUMERIC(12, 5) NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    aggressor_side VARCHAR(4) NOT NULL CHECK (aggressor_side IN ('BUY', 'SELL')),
    best_bid NUMERIC(12, 5),
    best_ask NUMERIC(12, 5),
    time TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, time)
);

-- 5. Prices Table (Market Data Ticks - Prepared for Hypertable Conversion)
CREATE TABLE IF NOT EXISTS prices (
    instrument VARCHAR(32) NOT NULL,
    bid NUMERIC(12, 5) NOT NULL,
    ask NUMERIC(12, 5) NOT NULL,
    last NUMERIC(12, 5) NOT NULL,
    volume BIGINT DEFAULT 0,
    time TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (instrument, time)
);

-- 6. Positions Table (Trader Net Exposure & Realized P/L)
CREATE TABLE IF NOT EXISTS positions (
    trader_id VARCHAR(64) NOT NULL REFERENCES traders(id),
    instrument VARCHAR(32) NOT NULL REFERENCES instruments(symbol),
    sod_pos INTEGER DEFAULT 0,
    sod_px NUMERIC(12, 5) DEFAULT 0,
    buy_qty INTEGER DEFAULT 0,
    sell_qty INTEGER DEFAULT 0,
    net_pos INTEGER DEFAULT 0,
    avg_px NUMERIC(12, 5) DEFAULT 0,
    realized_pl NUMERIC(14, 5) DEFAULT 0,
    PRIMARY KEY (trader_id, instrument)
);

-- 7. Risk Limits Table (ROM Risk Dashboard Controls)
CREATE TABLE IF NOT EXISTS risk_limits (
    id SERIAL PRIMARY KEY,
    trader_id VARCHAR(64) NOT NULL REFERENCES traders(id),
    instrument VARCHAR(32) NOT NULL REFERENCES instruments(symbol),
    max_long INTEGER DEFAULT 100,
    max_short INTEGER DEFAULT 100,
    max_order_qty_outrights INTEGER DEFAULT 50,
    max_order_qty_spreads INTEGER DEFAULT 100,
    trade_allowed BOOLEAN DEFAULT TRUE,
    limit_version INTEGER DEFAULT 1,
    UNIQUE (trader_id, instrument)
);

-- 8. Limit Increase Requests Table (Trader Limit Escalation & Admin Review)
CREATE TABLE IF NOT EXISTS limit_requests (
    id VARCHAR(64) PRIMARY KEY,
    trader_id VARCHAR(64) NOT NULL REFERENCES traders(id),
    instrument VARCHAR(32) NOT NULL REFERENCES instruments(symbol),
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

-- ============================================================================
-- Performance Indexes for Sub-Millisecond UI Queries
-- ============================================================================

-- Order Book UI: Fast retrieval of working orders per trader
CREATE INDEX IF NOT EXISTS idx_orders_trader_working 
ON orders (trader_id, status) 
WHERE status = 'WORKING';

-- Fill Book UI: Fast retrieval of trader fills sorted by newest first
CREATE INDEX IF NOT EXISTS idx_trades_buyer_time 
ON trades (buyer_id, time DESC);

CREATE INDEX IF NOT EXISTS idx_trades_seller_time 
ON trades (seller_id, time DESC);

-- Time & Sales (TAS) UI: Fast retrieval of public trade tape per instrument
CREATE INDEX IF NOT EXISTS idx_trades_instrument_time 
ON trades (instrument, time DESC);

-- Position Book UI: Fast retrieval of all contract positions for a trader
CREATE INDEX IF NOT EXISTS idx_positions_trader 
ON positions (trader_id);

-- Limit Requests: Fast query of pending/reviewed requests
CREATE INDEX IF NOT EXISTS idx_limit_requests_trader 
ON limit_requests (trader_id, status);

CREATE INDEX IF NOT EXISTS idx_limit_requests_status 
ON limit_requests (status, created_at DESC);