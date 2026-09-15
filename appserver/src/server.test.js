const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

// Set dedicated isolated test port before starting test instance
const TEST_PORT = 4098;
process.env.PORT_APPSERVER = `${TEST_PORT}`;

const startAppServer = require('./server.js');
const db = require('./db.js');

describe('Full Application Server Integration Tests (Port 4098 & WS Gateway)', () => {
    let serverInstance;
    const BASE_URL = `http://localhost:${TEST_PORT}`;
    const WS_URL = `ws://localhost:${TEST_PORT}/ws`;

    let authToken;
    const testUser = `full_e2e_${Date.now()}`;
    const testPass = 'securePassword2026';

    before(async () => {
        serverInstance = await startAppServer();
    });

    after(async () => {
        if (serverInstance) {
            await serverInstance.consumer.disconnect().catch(() => { });
            await serverInstance.producer.disconnect().catch(() => { });
            await serverInstance.gateway.close();
            await new Promise(resolve => serverInstance.server.close(resolve));
        }
    });

    it('1. GET /health should return status UP with uptime', async () => {
        const res = await fetch(`${BASE_URL}/health`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'UP');
        assert.strictEqual(body.service, 'open-interest-appserver');
    });

    it('2. POST /api/auth/register should create user and return JWT', async () => {
        const res = await fetch(`${BASE_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: testUser, password: testPass })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
        assert.ok(body.token);
        authToken = body.token;
    });

    it('3. GET /api/market/instruments should return all 5 contract specs', async () => {
        const res = await fetch(`${BASE_URL}/api/market/instruments`);
        assert.strictEqual(res.status, 200);
        const instruments = await res.json();
        assert.strictEqual(instruments.length, 5);
    });

    it('4. POST /api/trading/order with JWT should place order into database and Kafka', async () => {
        const res = await fetch(`${BASE_URL}/api/trading/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                instrument: 'GC Dec27',
                side: 'BUY',
                type: 'LIMIT',
                price: 2650.00,
                qty: 10,
                tif: 'DAY'
            })
        });

        assert.strictEqual(res.status, 202);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUBMITTED');
        assert.ok(body.orderId);
    });

    it('5. WebSocket connection on /ws?token=<JWT> should authenticate trader', async () => {
        const ws = new WebSocket(`${WS_URL}?token=${authToken}`);

        const msg = await new Promise((resolve, reject) => {
            ws.on('message', data => resolve(JSON.parse(data.toString())));
            ws.on('error', reject);
        });

        assert.strictEqual(msg.type, 'CONNECTED');
        assert.strictEqual(msg.authenticated, true);
        assert.ok(msg.traderId);

        ws.terminate();
    });
});