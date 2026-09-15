const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const authRouter = require('./auth.js');
const db = require('../db.js');

describe('Authentication & JWT Security Unit & Integration Tests', () => {
    let app;
    let server;
    const TEST_PORT = 4097;
    const testUsername = `auth_test_${Date.now()}`;
    const testPassword = 'securePassword123';
    let authToken;

    before(async () => {
        app = express();
        app.use(express.json());
        app.use('/api/auth', authRouter);

        // Run db init to ensure seed accounts have current .env password hashes
        await db.initDb();

        // Seed a valid known trader for deterministic auth testing
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(testPassword, salt);
        await db.query(
            'INSERT INTO traders (id, username, password_hash) VALUES ($1, $2, $3) ON CONFLICT (username) DO UPDATE SET password_hash = $3',
            [`trader_${Date.now()}`, testUsername, hash]
        );

        await new Promise(resolve => {
            server = app.listen(TEST_PORT, resolve);
        });
    });

    after(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('1. Should login user with correct password and return signed JWT', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: testUsername, password: testPassword })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
        assert.ok(body.token, 'JWT token must be returned');
        assert.strictEqual(body.trader.username, testUsername);

        authToken = body.token;
    });

    it('2. Should reject login with wrong password (401 INVALID_CREDENTIALS)', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: testUsername, password: 'WRONG_PASSWORD_XYZ' })
        });

        assert.strictEqual(res.status, 401);
        const body = await res.json();
        assert.strictEqual(body.error, 'INVALID_CREDENTIALS');
    });

    it('3. Should register a new trader account and return 201 with JWT', async () => {
        const newUsername = `new_reg_${Date.now()}`;

        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: newUsername, password: 'myNewPassword2026' })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
        assert.ok(body.token);
        assert.strictEqual(body.trader.username, newUsername);
    });

    it('4. Should reject duplicate username registration with 409 Conflict', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: testUsername, password: 'somePassword' })
        });

        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.error, 'USERNAME_ALREADY_EXISTS');
    });

    it('5. Should reject protected route GET /api/auth/me without token (401)', async () => {
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/me`);
        assert.strictEqual(res.status, 401);
        const body = await res.json();
        assert.strictEqual(body.error, 'ACCESS_TOKEN_REQUIRED');
    });

    it('6. Should allow access to GET /api/auth/me with valid Bearer token', async () => {
        const meRes = await fetch(`http://localhost:${TEST_PORT}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        assert.strictEqual(meRes.status, 200);
        const meBody = await meRes.json();
        assert.strictEqual(meBody.username, testUsername);
    });

    it('7. Should login as admin with ADMIN_PASSWORD from .env and role ADMIN', async () => {
        const adminPw = process.env.ADMIN_PASSWORD || 'T@jFUHkUVzkHoNhbj#98!';
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: adminPw, role: 'ADMIN' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
        assert.strictEqual(body.user.role, 'ADMIN');
    });

    it('8. Should login as trader1 with TRADER1_PASSWORD from .env', async () => {
        const t1Pw = process.env.TRADER1_PASSWORD || 'Tr1#oHMACIn3Am79!';
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'trader1', password: t1Pw, role: 'TRADER' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
        assert.strictEqual(body.user.role, 'TRADER');
    });

    it('9. Should login using trader_1 alias ID with TRADER1_PASSWORD', async () => {
        const t1Pw = process.env.TRADER1_PASSWORD || 'Tr1#oHMACIn3Am79!';
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'trader_1', password: t1Pw, role: 'TRADER' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
    });

    it('10. Should login as trader2 with TRADER2_PASSWORD from .env', async () => {
        const t2Pw = process.env.TRADER2_PASSWORD || 'Tr2#LXlPGY5LYibw!';
        const res = await fetch(`http://localhost:${TEST_PORT}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'trader2', password: t2Pw, role: 'TRADER' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.status, 'SUCCESS');
        assert.strictEqual(body.user.role, 'TRADER');
    });
});