const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const db = require('./db.js');
const authRouter = require('./routes/auth.js');
const adminRouter = require('./routes/admin.js');
const createTradingRouter = require('./routes/trading.js');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminDefaultDev2026!';
const TRADER1_PASSWORD = process.env.TRADER1_PASSWORD || 'Trader1DefaultDev2026!';
const TRADER2_PASSWORD = process.env.TRADER2_PASSWORD || 'Trader2DefaultDev2026!';
let server;
let baseUrl;
let adminToken;
let trader1Token;
let newTraderToken;
let newTraderId;

describe('Institutional RBAC & Authentication Integration Suite', () => {
    before(async () => {
        // 1. Run database migrations and seed default admin/trader accounts
        await db.initDb();

        // 2. Start test HTTP server
        const app = express();
        app.use(express.json());
        app.use('/api/auth', authRouter);
        app.use('/api/admin', adminRouter);
        app.use('/api/trading', createTradingRouter(null));

        server = http.createServer(app);
        await new Promise((resolve) => {
            server.listen(0, () => {
                const port = server.address().port;
                baseUrl = `http://localhost:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('1. Admin Login returns JWT token with ADMIN role', async () => {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.token, 'Token must be present');
        assert.strictEqual(data.user.role, 'ADMIN');
        adminToken = data.token;
    });

    test('2. Trader1 Login returns JWT token with TRADER role', async () => {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'trader1', password: TRADER1_PASSWORD }),
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.token, 'Token must be present');
        assert.strictEqual(data.user.role, 'TRADER');
        assert.strictEqual(data.user.username, 'trader1');
        trader1Token = data.token;
    });

    test('3. Registering new trader assigns unique ID, role TRADER, and rejects reserved name', async () => {
        // Attempt reserved username 'admin'
        const reservedRes = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'password123' }),
        });
        assert.strictEqual(reservedRes.status, 400);

        // Register unique trader
        const uniqueUsername = `trader_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const regRes = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: uniqueUsername, password: 'password123' }),
        });

        assert.strictEqual(regRes.status, 201);
        const regData = await regRes.json();
        assert.ok(regData.token, 'Token returned');
        assert.strictEqual(regData.user.role, 'TRADER');
        assert.ok(regData.user.id.startsWith('trader_'), 'Trader ID starts with trader_');

        newTraderToken = regData.token;
        newTraderId = regData.user.id;
    });

    test('4. Non-admin (Trader) is blocked from accessing Admin endpoints with 403 Forbidden', async () => {
        const res = await fetch(`${baseUrl}/api/admin/traders`, {
            headers: { Authorization: `Bearer ${trader1Token}` },
        });

        assert.strictEqual(res.status, 403);
        const data = await res.json();
        assert.strictEqual(data.error, 'FORBIDDEN_ADMIN_ACCESS_REQUIRED');
    });

    test('5. Admin can list all registered traders via /api/admin/traders', async () => {
        const res = await fetch(`${baseUrl}/api/admin/traders`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });

        assert.strictEqual(res.status, 200);
        const traders = await res.json();
        assert.ok(Array.isArray(traders));
        assert.ok(traders.some((t) => t.username === 'admin'));
        assert.ok(traders.some((t) => t.username === 'trader1'));
    });

    test('6. Trader cannot modify risk limits directly via /api/trading/limits', async () => {
        const res = await fetch(`${baseUrl}/api/trading/limits`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${trader1Token}`,
            },
            body: JSON.stringify({
                instrument: 'GC Dec27',
                maxOrderQty: 500,
                maxPosition: 1000,
                maxNotional: 50000000,
            }),
        });

        assert.strictEqual(res.status, 403);
    });

    test('7. Trader can submit a limit-increase request (POST /api/trading/limit-requests)', async () => {
        const res = await fetch(`${baseUrl}/api/trading/limit-requests`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${newTraderToken}`,
            },
            body: JSON.stringify({
                instrument: 'GC Dec27',
                reqMaxOrderQty: 75,
                reqMaxPosition: 150,
                reqMaxNotional: 15000000,
                reason: 'Need increased inventory for quarterly roll',
            }),
        });

        assert.strictEqual(res.status, 201);
        const data = await res.json();
        assert.strictEqual(data.status, 'SUBMITTED');
        assert.strictEqual(data.request.instrument, 'GC Dec27');
        assert.strictEqual(data.request.reqMaxOrderQty, 75);
        assert.strictEqual(data.request.status, 'PENDING');
        assert.strictEqual(data.request.traderId, newTraderId);
    });

    test('8. Trader can view their submitted limit requests (GET /api/trading/limit-requests)', async () => {
        const res = await fetch(`${baseUrl}/api/trading/limit-requests`, {
            headers: { Authorization: `Bearer ${newTraderToken}` },
        });

        assert.strictEqual(res.status, 200);
        const requests = await res.json();
        assert.ok(Array.isArray(requests));
        assert.ok(requests.length >= 1);
        assert.strictEqual(requests[0].traderId, newTraderId);
        assert.strictEqual(requests[0].status, 'PENDING');
    });

    test('9. Admin can review and approve a pending limit request', async () => {
        // A. Admin retrieves pending requests
        const listRes = await fetch(`${baseUrl}/api/admin/limit-requests`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.strictEqual(listRes.status, 200);
        const allRequests = await listRes.json();
        const pendingReq = allRequests.find((r) => r.traderId === newTraderId && r.status === 'PENDING');
        assert.ok(pendingReq, 'Pending request must exist');

        // B. Admin approves request
        const reviewRes = await fetch(`${baseUrl}/api/admin/limit-requests/${pendingReq.id}/review`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                action: 'APPROVE',
                adminComment: 'Approved following risk manager review',
            }),
        });

        assert.strictEqual(reviewRes.status, 200);
        const reviewData = await reviewRes.json();
        assert.strictEqual(reviewData.request.status, 'APPROVED');
        assert.strictEqual(reviewData.request.admin_comment, 'Approved following risk manager review');

        // C. Trader now sees APPROVED status
        const traderCheckRes = await fetch(`${baseUrl}/api/trading/limit-requests`, {
            headers: { Authorization: `Bearer ${newTraderToken}` },
        });
        const traderRequests = await traderCheckRes.json();
        const approvedReq = traderRequests.find((r) => r.id === pendingReq.id);
        assert.strictEqual(approvedReq.status, 'APPROVED');

        // D. Trader GET /api/trading/limits reflects the newly approved limits immediately
        const traderLimitsRes = await fetch(`${baseUrl}/api/trading/limits`, {
            headers: { Authorization: `Bearer ${newTraderToken}` },
        });
        assert.strictEqual(traderLimitsRes.status, 200);
        const traderLimitsData = await traderLimitsRes.json();
        const gcLimit = traderLimitsData.limits.find((l) => l.instrument === 'GC Dec27');
        assert.ok(gcLimit, 'GC Dec27 limit exists');
        assert.strictEqual(gcLimit.maxOrderQty, 75);
        assert.strictEqual(gcLimit.maxPosition, 150);
        assert.strictEqual(gcLimit.maxNotional, 15000000);
        assert.strictEqual(gcLimit.tradeAllowed, true);

        // E. Admin GET /api/admin/limits/:traderId also reflects the newly approved limits
        const adminLimitsRes = await fetch(`${baseUrl}/api/admin/limits/${newTraderId}`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        assert.strictEqual(adminLimitsRes.status, 200);
        const adminLimitsData = await adminLimitsRes.json();
        const adminGcLimit = adminLimitsData.limits.find((l) => l.instrument === 'GC Dec27');
        assert.ok(adminGcLimit, 'GC Dec27 limit exists in admin view');
        assert.strictEqual(adminGcLimit.maxOrderQty, 75);
        assert.strictEqual(adminGcLimit.maxPosition, 150);
        assert.strictEqual(adminGcLimit.maxNotional, 15000000);
        assert.strictEqual(adminGcLimit.tradeAllowed, true);
    });

    test('10. Admin can directly configure risk limits for any trader (POST /api/admin/limits)', async () => {
        const res = await fetch(`${baseUrl}/api/admin/limits`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
                traderId: newTraderId,
                instrument: 'CL Dec27',
                maxOrderQty: 100,
                maxPosition: 200,
                maxNotional: 10000000,
                tradeAllowed: true,
            }),
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status, 'SUCCESS');
        assert.strictEqual(data.maxOrderQty, 100);
        assert.strictEqual(data.maxPosition, 200);
        assert.strictEqual(data.maxNotional, 10000000);

        // Verify instantly reflected in GET /api/trading/limits
        const traderLimitsRes = await fetch(`${baseUrl}/api/trading/limits`, {
            headers: { Authorization: `Bearer ${newTraderToken}` },
        });
        assert.strictEqual(traderLimitsRes.status, 200);
        const traderLimitsData = await traderLimitsRes.json();
        const clLimit = traderLimitsData.limits.find((l) => l.instrument === 'CL Dec27');
        assert.ok(clLimit);
        assert.strictEqual(clLimit.maxOrderQty, 100);
        assert.strictEqual(clLimit.maxPosition, 200);
        assert.strictEqual(clLimit.maxNotional, 10000000);
    });

    test('11. Login rejects with 403 ROLE_MISMATCH when requested role does not match account role', async () => {
        // Attempt login as ADMIN with trader1 credentials
        const traderAsAdminRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'trader1', password: TRADER1_PASSWORD, role: 'ADMIN' }),
        });

        assert.strictEqual(traderAsAdminRes.status, 403);
        const traderData = await traderAsAdminRes.json();
        assert.strictEqual(traderData.error, 'ROLE_MISMATCH');

        // Attempt login as TRADER with admin credentials
        const adminAsTraderRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD, role: 'TRADER' }),
        });

        assert.strictEqual(adminAsTraderRes.status, 403);
        const adminData = await adminAsTraderRes.json();
        assert.strictEqual(adminData.error, 'ROLE_MISMATCH');
    });

    test('12. Login succeeds when requested role matches account role', async () => {
        const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD, role: 'ADMIN' }),
        });
        assert.strictEqual(adminRes.status, 200);
        const adminData = await adminRes.json();
        assert.strictEqual(adminData.user.role, 'ADMIN');

        const traderRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'trader1', password: TRADER1_PASSWORD, role: 'TRADER' }),
        });
        assert.strictEqual(traderRes.status, 200);
        const traderData = await traderRes.json();
        assert.strictEqual(traderData.user.role, 'TRADER');
    });

    test('13. Non-admin (Trader) is forbidden from accessing /api/admin/market-mode', async () => {
        const res = await fetch(`${baseUrl}/api/admin/market-mode`, {
            headers: { Authorization: `Bearer ${trader1Token}` },
        });
        assert.strictEqual(res.status, 403);
    });

    test('14. Admin POST /api/admin/market-mode validates mode parameter', async () => {
        const invalidRes = await fetch(`${baseUrl}/api/admin/market-mode`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({ mode: 'INVALID_MODE' }),
        });

        assert.strictEqual(invalidRes.status, 400);
        const errData = await invalidRes.json();
        assert.ok(errData.error.includes('Invalid mode'));
    });
});

