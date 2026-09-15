-- ============================================================================
-- Open Interest — TimescaleDB Hypertables, Compression & Continuous Aggregates
-- File: init-db/02_timescaledb.sql
-- ============================================================================

-- 0. Ensure TimescaleDB extension is active on open_interest database
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- 1. Create Hypertables for Time-Series Data
SELECT create_hypertable('trades', by_range('time'), if_not_exists => true);
SELECT set_chunk_time_interval('trades', INTERVAL '1 hour');

SELECT create_hypertable('prices', by_range('time'), if_not_exists => true);
SELECT set_chunk_time_interval('prices', INTERVAL '1 day');

-- 2. Configure Compression Policies
-- Trades older than 1 hour: compressed by instrument segment
ALTER TABLE trades SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'time DESC',
    timescaledb.compress_segmentby = 'instrument'
);
SELECT add_compression_policy('trades', INTERVAL '1 hour', if_not_exists => true);

-- Prices older than 10 minutes: compressed
ALTER TABLE prices SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'instrument'
);
SELECT add_compression_policy('prices', INTERVAL '10 minutes', if_not_exists => true);

-- 3. Continuous Aggregate View for 1-Minute Candlestick Charts
CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_1min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    instrument,
    FIRST(price, time)  AS open,
    MAX(price)          AS high,
    MIN(price)          AS low,
    LAST(price, time)   AS close,
    SUM(qty)            AS volume
FROM trades
GROUP BY bucket, instrument
WITH NO DATA;

-- 4. Continuous Aggregate Refresh Policy (Refreshes every 30s)
SELECT add_continuous_aggregate_policy('ohlcv_1min',
    start_offset      => INTERVAL '1 hour',
    end_offset        => INTERVAL '30 seconds',
    schedule_interval => INTERVAL '30 seconds',
    if_not_exists     => true);