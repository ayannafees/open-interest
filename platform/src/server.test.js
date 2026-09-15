const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const RiskEngine = require('./rom/riskEngine.js');
const SmartOrderRouter = require('./sor/router.js');
const PIQEngine = require('./piq/piqEngine.js');

describe('Platform Gateway Server Integration Tests (Port 4002)', () => {
    let app;
    let server;
    let riskEngine;
    let sor;
    let piqEngine;
    let mockKafkaMessages = [];
    const TEST_PORT = 4098;

    before(async () => {
        app = express();
        app.use(express.json());

        const mockProducer = {
            send: async ({ topic, messages }) => {
                mockKafkaMessages.push({ topic, messages });
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        riskEngine = new RiskEngine();
        sor = new SmartOrderRouter(mockProducer);
        piqEngine = new PIQEngine(mockProducer);

        // Setup HTTP Endpoints
        app.get('/health', (req, res) => {
            res.json({ status: 'UP', service: 'open-interest-platform' });
        });

        app.get('/risk/position/:traderId/:instrument', (req, res) => {
            const pos = riskEngine.getPosition(req.params.traderId, decodeURIComponent(req.params.instrument));
            res.json(pos);
        });

        app.post('/risk/limits', (req, res) => {
            const { traderId, instrument, maxOrderQty, maxPosition, maxNotional } = req.body;
            riskEngine.setTraderLimits(traderId, instrument, { maxOrderQty, maxPosition, maxNotional });
            res.json({ status: 'UPDATED', limits: riskEngine.getTraderLimits(traderId, instrument) });
        });

        app.get('/piq/:orderId', (req, res) => {
            const tracked = piqEngine.trackedOrders.get(req.params.orderId);
            if (!tracked) return res.status(404).json({ error: 'Not found' });
            res.json(piqEngine.calculateMetrics(req.params.orderId, 2650.00, 2650.10, 10));
        });

        app.post('/order', async (req, res) => {
            const { id, orderId, traderId, instrument, side, type, price, qty } = req.body;
            const order = { id: id || orderId, traderId, instrument, side, type: type || 'LIMIT', price: Number(price), qty: parseInt(qty, 10) };

            const check = riskEngine.checkOrder(order);
            if (!check.allowed) {
                await mockProducer.send({
                    topic: 'order_events',
                    messages: [{ key: order.id, value: JSON.stringify({ orderId: order.id, status: 'REJECTED', reason: check.reason }) }]
                });
                return res.json({ status: 'REJECTED', reason: check.reason });
            }

            riskEngine.reserveWorkingMargin(order);
            const routed = sor.routeOrder(order);
            await sor.dispatch(routed);
            piqEngine.trackOrder(order, 0);

            res.json({ status: 'ROUTED', topic: routed.topic, orderId: order.id });
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

    it('1. GET /health should return status UP', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/health`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'UP');
    });

    it('2. POST /order should pass ROM check, reserve margin, and route to venue topic', async () => {
        mockKafkaMessages = [];

        const orderPayload = {
            orderId: 'plat-ord-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10
        };

        const res = await fetch(`http://localhost:${TEST_PORT}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'ROUTED');
        assert.strictEqual(body.topic, 'raw_orders_comex');

        // Verify ROM reserved working margin
        const pos = riskEngine.getPosition('trader1', 'GC Dec27');
        assert.strictEqual(pos.workingBuys, 10);

        // Verify PIQ tracked order
        assert.strictEqual(piqEngine.trackedOrders.has('plat-ord-1'), true);

        // Verify Kafka message dispatched to raw_orders_comex
        assert.strictEqual(mockKafkaMessages.length, 1);
        assert.strictEqual(mockKafkaMessages[0].topic, 'raw_orders_comex');
    });

    it('3. POST /order exceeding risk limits should be REJECTED and emit order_event', async () => {
        mockKafkaMessages = [];

        const hugeOrder = {
            orderId: 'plat-huge-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 500 // Exceeds maxOrderQty of 100
        };

        const res = await fetch(`http://localhost:${TEST_PORT}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hugeOrder)
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'REJECTED');
        assert.strictEqual(body.reason, 'EXCEEDS_MAX_ORDER_QTY');

        // Verify rejection event sent to Kafka
        assert.strictEqual(mockKafkaMessages.length, 1);
        assert.strictEqual(mockKafkaMessages[0].topic, 'order_events');
    });

    it('4. GET /risk/position/:traderId/:instrument should return real-time position state', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/risk/position/trader1/GC%20Dec27`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.traderId, 'trader1');
        assert.strictEqual(body.workingBuys, 10);
    });

    it('5. POST /risk/limits should update trader risk parameters dynamically', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/risk/limits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                traderId: 'trader1',
                instrument: 'GC Dec27',
                maxOrderQty: 75,
                maxPosition: 150,
                maxNotional: 15000000
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'UPDATED');
        assert.strictEqual(body.limits.maxOrderQty, 75);
        assert.strictEqual(body.limits.maxPosition, 150);
    });

    it('6. GET /piq/:orderId should return live PIQ telemetry', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/piq/plat-ord-1`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.orderId, 'plat-ord-1');
        assert.strictEqual(body.piq, 0);
        assert.strictEqual(body.fillProbability, 1.0);
    });
});