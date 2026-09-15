const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const createTradingRouter = require('./trading.js');
const { JWT_SECRET } = require('./auth.js');
const db = require('../db.js');

describe('Trading REST APIs Unit & Integration Tests (JWT & Kafka Ingestion)', () => {
    let app;
    let server;
    let mockKafkaMessages = [];
    const TEST_PORT = 4096;

    const testTraderId = `trader_test_${Date.now()}`;
    let validToken;
    let placedOrderId;

    before(async () => {
        app = express();
        app.use(express.json());

        const mockProducer = {
            send: async ({ topic, messages }) => {
                mockKafkaMessages.push({ topic, messages });
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        app.use('/api/trading', createTradingRouter(mockProducer));

        await db.query(
            'INSERT INTO traders (id, username, password_hash) VALUES ($1, $2, $3)',
            [testTraderId, `user_${Date.now()}`, 'dummyHash']
        );

        await db.query(`
            INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, max_notional, trade_allowed, limit_version)
            SELECT $1, symbol, 100, 100, 50, 100, 10000000, TRUE, 1
            FROM instruments
            ON CONFLICT (trader_id, instrument) DO NOTHING;
        `, [testTraderId]).catch(() => {});

        const allInstruments = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];
        for (const inst of allInstruments) {
            await fetch(`http://localhost:4002/risk/limits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    traderId: testTraderId,
                    instrument: inst,
                    maxOrderQty: 100,
                    maxPosition: 200,
                    maxNotional: 10000000
                })
            }).catch(() => {});
        }

        validToken = jwt.sign({ id: testTraderId, username: 'testTrader' }, JWT_SECRET, { expiresIn: '1h' });

        await new Promise(resolve => {
            server = app.listen(TEST_PORT, resolve);
        });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('1. POST /order without JWT token should be rejected (401 Unauthorized)', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/trading/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instrument: 'GC Dec27', side: 'BUY', price: 2650.00, qty: 5 })
        });

        assert.strictEqual(res.status, 401);
    });

    it('2. POST /order with invalid instrument should return 400 Bad Request', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/trading/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${validToken}`
            },
            body: JSON.stringify({ instrument: 'UNKNOWN_CRYPTO', side: 'BUY', price: 100, qty: 5 })
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid instrument'));
    });

    it('3. POST /order should persist to Postgres and publish to Kafka orders topic', async () => {
        mockKafkaMessages = [];

        const orderPayload = {
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        };

        const res = await fetch(`http://localhost:${TEST_PORT}/api/trading/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${validToken}`
            },
            body: JSON.stringify(orderPayload)
        });

        assert.strictEqual(res.status, 202);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUBMITTED');
        assert.strictEqual(body.qty, 10);
        assert.ok(body.orderId);

        placedOrderId = body.orderId;

        assert.strictEqual(mockKafkaMessages.length, 1);
        assert.strictEqual(mockKafkaMessages[0].topic, 'orders');
        assert.strictEqual(mockKafkaMessages[0].messages[0].key, 'GC Dec27');

        const kafkaOrder = JSON.parse(mockKafkaMessages[0].messages[0].value);
        assert.strictEqual(kafkaOrder.id, placedOrderId);
        assert.strictEqual(kafkaOrder.traderId, testTraderId);
    });

    it('4. GET /orders should return the submitted active order from database', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/trading/orders`, {
            headers: { 'Authorization': `Bearer ${validToken}` }
        });

        assert.strictEqual(res.status, 200);
        const orders = await res.json();
        assert.ok(Array.isArray(orders));

        const found = orders.find(o => o.id === placedOrderId);
        assert.ok(found, 'Placed order must exist in active orders query');
        assert.strictEqual(found.instrument, 'GC Dec27');
        assert.strictEqual(found.side, 'BUY');
    });

    it('5. DELETE /order/:orderId should publish cancel action to Kafka', async () => {
        mockKafkaMessages = [];

        const res = await fetch(`http://localhost:${TEST_PORT}/api/trading/order/${placedOrderId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${validToken}`
            },
            body: JSON.stringify({ instrument: 'GC Dec27' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.ok(body.status === 'CANCELLED' || body.status === 'CANCEL_REQUESTED');

        assert.strictEqual(mockKafkaMessages.length, 1);
        const kafkaMsg = JSON.parse(mockKafkaMessages[0].messages[0].value);
        assert.strictEqual(kafkaMsg.action, 'CANCEL');
        assert.strictEqual(kafkaMsg.orderId, placedOrderId);
    });

    it('6. GET /trades should return trade history array for authenticated trader', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/trading/trades`, {
            headers: { 'Authorization': `Bearer ${validToken}` }
        });

        assert.strictEqual(res.status, 200);
        const trades = await res.json();
        assert.ok(Array.isArray(trades));
    });
});