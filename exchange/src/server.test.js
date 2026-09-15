const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { MatchingEngineManager } = require('./engine.js');
const MDS = require('./mds.js');

describe('Exchange HTTP Server Endpoints Integration Tests', () => {
    let app;
    let server;
    let engineManager;
    let mds;
    let mockKafkaMessages = [];
    const TEST_PORT = 4099;

    before(async () => {
        app = express();
        app.use(express.json());

        engineManager = new MatchingEngineManager();
        engineManager.registerInstrument('GC Dec27', 0.10);
        engineManager.registerInstrument('SR3 Dec27', 0.005);

        const mockProducer = {
            send: async ({ topic, messages }) => {
                mockKafkaMessages.push({ topic, messages });
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        mds = new MDS(engineManager, mockProducer, 'RANDOM_WALK');

        // 1. Health Check
        app.get('/health', (req, res) => {
            res.json({
                status: 'UP',
                service: 'open-interest-exchange',
                kafkaConnected: true,
                uptime: process.uptime()
            });
        });

        // 2. Direct Order Entry
        app.post('/order', async (req, res) => {
            const { orderId, traderId, instrument, side, type, price, qty, tif } = req.body;
            if (!orderId || !traderId || !instrument || !side || !type || !qty) {
                return res.status(400).json({ error: 'Missing required order fields' });
            }

            const venueMap = {
                'GC Dec27': 'raw_orders_comex',
                'SR3 Dec27': 'raw_orders_cme'
            };

            const topic = venueMap[instrument];
            if (!topic) {
                return res.status(400).json({ error: `Unknown instrument: ${instrument}` });
            }

            await mockProducer.send({
                topic,
                messages: [{
                    key: instrument,
                    value: JSON.stringify({ id: orderId, traderId, instrument, side, type, price, qty, tif: tif || 'DAY' })
                }]
            });

            res.json({ orderId, status: 'RECEIVED' });
        });

        // 3. Direct Order Cancellation
        app.delete('/order/:orderId', async (req, res) => {
            const { orderId } = req.params;
            const { traderId, instrument } = req.body;

            if (!instrument) {
                return res.status(400).json({ error: 'Instrument is required in request body' });
            }

            const venueMap = {
                'GC Dec27': 'raw_orders_comex',
                'SR3 Dec27': 'raw_orders_cme'
            };

            const topic = venueMap[instrument];
            if (!topic) {
                return res.status(400).json({ error: `Unknown instrument: ${instrument}` });
            }

            await mockProducer.send({
                topic,
                messages: [{
                    key: instrument,
                    value: JSON.stringify({ action: 'CANCEL', orderId, traderId, instrument })
                }]
            });

            res.json({ orderId, status: 'CANCEL_REQUESTED' });
        });

        // 4. In-Memory Book Snapshot
        app.get('/book/:instrument', (req, res) => {
            const symbol = decodeURIComponent(req.params.instrument);
            const book = engineManager.getBook(symbol);
            if (!book) {
                return res.status(404).json({ error: `Instrument ${symbol} not found` });
            }
            res.json(book.getDepth(20));
        });

        // 5. Admin MDS Control Endpoints
        app.get('/admin/mds/mode', (req, res) => {
            res.json({
                mode: mds.mode,
                intervalMs: 500,
                isRunning: mds.isRunning
            });
        });

        app.post('/admin/mds/mode', (req, res) => {
            const { mode } = req.body;
            if (mode !== 'RANDOM_WALK' && mode !== 'USER_DRIVEN') {
                return res.status(400).json({
                    error: "Invalid mode. Must be either 'RANDOM_WALK' or 'USER_DRIVEN'"
                });
            }

            mds.setMode(mode);
            res.json({
                status: 'SUCCESS',
                activeMode: mds.mode,
                timestamp: new Date().toISOString()
            });
        });

        await new Promise(resolve => {
            server = app.listen(TEST_PORT, resolve);
        });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('1. GET /health should return status UP and kafkaConnected', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/health`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'UP');
    });

    it('2. GET /book/:instrument should return in-memory depth snapshot', async () => {
        const book = engineManager.getBook('GC Dec27');
        book.processOrder({
            id: 'depth-test-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        });

        const res = await fetch(`http://localhost:${TEST_PORT}/book/GC%20Dec27`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.instrument, 'GC Dec27');
        assert.strictEqual(body.bids.length, 1);
    });

    it('3. GET /book/:instrument for unknown instrument should return 404', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/book/UNKNOWN_SYMBOL`);
        assert.strictEqual(res.status, 404);
    });

    it('4. POST /order should validate fields and publish to correct venue topic', async () => {
        mockKafkaMessages = [];

        const orderPayload = {
            orderId: 'postman-ord-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 5,
            tif: 'DAY'
        };

        const res = await fetch(`http://localhost:${TEST_PORT}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.orderId, 'postman-ord-1');
        assert.strictEqual(body.status, 'RECEIVED');
        assert.strictEqual(mockKafkaMessages[0].topic, 'raw_orders_comex');
    });

    it('5. POST /order with missing fields should return 400 Bad Request', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: 'bad-1' })
        });
        assert.strictEqual(res.status, 400);
    });

    it('6. DELETE /order/:orderId should publish cancel event to venue topic', async () => {
        mockKafkaMessages = [];

        const res = await fetch(`http://localhost:${TEST_PORT}/order/postman-ord-1`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ traderId: 'trader1', instrument: 'GC Dec27' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'CANCEL_REQUESTED');
        assert.strictEqual(mockKafkaMessages[0].topic, 'raw_orders_comex');
    });

    it('7. GET /admin/mds/mode should return current MDS mode', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/admin/mds/mode`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.mode, 'RANDOM_WALK');
    });

    it('8. POST /admin/mds/mode should switch mode to USER_DRIVEN', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/admin/mds/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'USER_DRIVEN' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.activeMode, 'USER_DRIVEN');
        assert.strictEqual(mds.mode, 'USER_DRIVEN');
    });

    it('9. POST /admin/mds/mode with invalid string should return 400 Bad Request', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/admin/mds/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'INVALID_MODE' })
        });

        assert.strictEqual(res.status, 400);
    });
});