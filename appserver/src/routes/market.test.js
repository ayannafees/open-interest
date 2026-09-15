const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const MOCK_EXCHANGE_PORT = 4094;
process.env.EXCHANGE_URL = `http://localhost:${MOCK_EXCHANGE_PORT}`;

const marketRouter = require('./market.js');
const db = require('../db.js');

describe('Market Data & OHLCV Candlestick Unit & Integration Tests', () => {
    let app;
    let server;
    let mockExchangeServer;
    const TEST_PORT = 4095;

    before(async () => {
        app = express();
        app.use(express.json());
        app.use('/api/market', marketRouter);

        await new Promise(resolve => {
            server = app.listen(TEST_PORT, resolve);
        });

        const exApp = express();
        exApp.get('/book/:instrument', (req, res) => {
            res.json({
                instrument: req.params.instrument,
                bids: [{ price: 2650.00, qty: 10, ordersCount: 1 }],
                asks: [{ price: 2650.10, qty: 15, ordersCount: 2 }],
                bestBid: 2650.00,
                bestAsk: 2650.10
            });
        });

        await new Promise(resolve => {
            mockExchangeServer = exApp.listen(MOCK_EXCHANGE_PORT, resolve);
        });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (mockExchangeServer) {
            await new Promise(resolve => mockExchangeServer.close(resolve));
        }
    });

    it('1. GET /instruments should return all 5 seeded contract specifications', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/market/instruments`);
        assert.strictEqual(res.status, 200);
        const instruments = await res.json();

        assert.ok(Array.isArray(instruments));
        assert.strictEqual(instruments.length, 5);

        const gold = instruments.find(i => i.symbol === 'GC Dec27');
        assert.ok(gold);
        assert.strictEqual(gold.exchange, 'COMEX');
        assert.strictEqual(Number(gold.tick_size), 0.10);
    });

    it('2. GET /candles/:instrument should return OHLCV candlestick buckets', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/market/candles/GC%20Dec27?timeframe=1m&limit=50`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.instrument, 'GC Dec27');
        assert.strictEqual(body.timeframe, '1m');
        assert.ok(Array.isArray(body.candles));
    });

    it('3. GET /tape/:instrument should return public Time & Sales trades array', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/market/tape/GC%20Dec27?limit=20`);
        assert.strictEqual(res.status, 200);
        const trades = await res.json();

        assert.ok(Array.isArray(trades));
    });

    it('4. GET /depth/:instrument should return 20-level order book depth snapshot', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/market/depth/GC%20Dec27`);
        assert.strictEqual(res.status, 200);
        const depth = await res.json();

        assert.strictEqual(depth.instrument, 'GC Dec27');
        assert.ok(Array.isArray(depth.bids));
        assert.ok(Array.isArray(depth.asks));
        assert.strictEqual(depth.bestBid, 2650.00);
    });
});