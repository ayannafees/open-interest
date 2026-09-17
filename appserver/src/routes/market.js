require('dotenv').config();
const express = require('express');
const db = require('../db.js');

const router = express.Router();
const EXCHANGE_URL = process.env.EXCHANGE_URL || 'http://localhost:4001';

const TIMEFRAME_MAP = {
    '1s': { bucket: '1 second', range: '1 hour' },
    '5s': { bucket: '5 seconds', range: '2 hours' },
    '1m': { bucket: '1 minute', range: '24 hours' },
    '5m': { bucket: '5 minutes', range: '3 days' },
    '15m': { bucket: '15 minutes', range: '7 days' },
    '1h': { bucket: '1 hour', range: '30 days' },
    '1d': { bucket: '1 day', range: '365 days' }
};

/**
 * 1. GET /api/market/instruments
 */
router.get('/instruments', async (req, res) => {
    try {
        const result = await db.query(`
      SELECT symbol, description, exchange, family, tick_size, lot_size, start_price 
      FROM instruments 
      ORDER BY symbol ASC
    `);
        res.json(result.rows);
    } catch (err) {
        console.error('[Market Error] GET /instruments failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * 2. GET /api/market/depth/:instrument
 */
router.get('/depth/:instrument', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.instrument);
        const exRes = await fetch(`${EXCHANGE_URL}/book/${encodeURIComponent(symbol)}`);

        if (exRes.ok) {
            const depth = await exRes.json();
            return res.json(depth);
        }

        res.status(exRes.status).json({ error: 'FAILED_TO_FETCH_DEPTH_FROM_EXCHANGE' });
    } catch (err) {
        console.error('[Market Error] GET /depth failed:', err.message);
        res.status(500).json({ error: 'EXCHANGE_GATEWAY_UNREACHABLE' });
    }
});

/**
 * 3. GET /api/market/stats/:instrument
 * Returns total session volume (sum of lots traded today), high, low, open, and last price.
 */
router.get('/stats/:instrument', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.instrument);

        const todayResult = await db.query(`
          SELECT 
            COALESCE(SUM(qty), 0)::int AS volume,
            COALESCE(MAX(price), 0)::float AS high,
            COALESCE(MIN(price), 0)::float AS low,
            (array_agg(price ORDER BY time ASC))[1]::float AS open,
            (array_agg(price ORDER BY time DESC))[1]::float AS last
          FROM trades 
          WHERE instrument = $1 AND (time >= CURRENT_DATE OR time >= (NOW() AT TIME ZONE 'UTC')::date);
        `, [symbol]);

        let row = todayResult.rows[0];

        if (!row || !row.volume || row.volume === 0) {
            const allTimeResult = await db.query(`
              SELECT 
                COALESCE(SUM(qty), 0)::int AS volume,
                COALESCE(MAX(price), 0)::float AS high,
                COALESCE(MIN(price), 0)::float AS low,
                (array_agg(price ORDER BY time ASC))[1]::float AS open,
                (array_agg(price ORDER BY time DESC))[1]::float AS last
              FROM trades 
              WHERE instrument = $1;
            `, [symbol]);

            if (allTimeResult.rows.length > 0 && allTimeResult.rows[0].volume > 0) {
                row = allTimeResult.rows[0];
            }
        }

        res.json({
            instrument: symbol,
            volume: parseInt(row?.volume, 10) || 0,
            high: parseFloat(row?.high) || 0,
            low: parseFloat(row?.low) || 0,
            open: parseFloat(row?.open) || 0,
            last: parseFloat(row?.last) || 0
        });
    } catch (err) {
        console.error('[Market Error] GET /stats failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * 4. GET /api/market/candles/:instrument
 */
router.get('/candles/:instrument', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.instrument);
        const timeframeKey = req.query.timeframe || '1m';
        const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);

        const tf = TIMEFRAME_MAP[timeframeKey] || TIMEFRAME_MAP['1m'];

        const tradeCandlesQuery = `
          SELECT 
            time_bucket($1::interval, time) AS bucket,
            (array_agg(price ORDER BY time ASC))[1] AS open,
            MAX(price) AS high,
            MIN(price) AS low,
            (array_agg(price ORDER BY time DESC))[1] AS close,
            SUM(qty) AS volume
          FROM trades
          WHERE instrument = $2 AND time > NOW() - $3::interval
          GROUP BY bucket
          ORDER BY bucket ASC
          LIMIT $4;
        `;

        const result = await db.query(tradeCandlesQuery, [tf.bucket, symbol, tf.range, limit]);

        const candles = result.rows.map(row => ({
            time: Math.floor(new Date(row.bucket).getTime() / 1000),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: parseInt(row.volume, 10) || 0
        }));

        res.json({
            instrument: symbol,
            timeframe: timeframeKey,
            count: candles.length,
            candles
        });
    } catch (err) {
        console.error('[Market Error] GET /candles failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * 5. GET /api/market/tape/:instrument
 */
router.get('/tape/:instrument', async (req, res) => {
    try {
        const symbol = decodeURIComponent(req.params.instrument);
        const limit = Math.min(200, parseInt(req.query.limit, 10) || 200);

        const result = await db.query(`
          SELECT 
            id, 
            buyer_id AS "buyerId", 
            seller_id AS "sellerId", 
            instrument, 
            price, 
            qty, 
            aggressor_side AS "aggressorSide", 
            time 
          FROM trades 
          WHERE instrument = $1 
          ORDER BY time DESC 
          LIMIT $2;
        `, [symbol, limit]);

        const trades = result.rows.map(row => {
            const rawSide = row.aggressorSide || row.aggressor_side || 'BUY';
            const normalizedSide = String(rawSide).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

            return {
                id: row.id,
                buyerId: row.buyerId || row.buyer_id,
                sellerId: row.sellerId || row.seller_id,
                instrument: row.instrument,
                price: parseFloat(row.price),
                qty: parseInt(row.qty, 10),
                aggressorSide: normalizedSide,
                side: normalizedSide,
                time: new Date(row.time).toISOString()
            };
        });

        res.json(trades);
    } catch (err) {
        console.error('[Market Error] GET /tape failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

module.exports = router;