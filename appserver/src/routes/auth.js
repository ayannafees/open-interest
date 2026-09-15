const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db.js');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'open_interest_institutional_secret_jwt_key_2026';
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:4002';

/**
 * ============================================================================
 * 1. AUTHENTICATION & RBAC MIDDLEWARE
 * ============================================================================
 * Extracts the JWT from the 'Authorization: Bearer <token>' header.
 * Verifies the cryptographic HMAC signature in CPU RAM (< 1 microsecond).
 * Attaches the verified decoded payload to `req.user`.
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"

    if (!token) {
        return res.status(401).json({ error: 'ACCESS_TOKEN_REQUIRED' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
        }
        req.user = {
            id: user.id,
            username: user.username,
            role: user.role || 'TRADER'
        };
        next();
    });
}

/**
 * Middleware: Strictly requires ADMIN role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({
            error: 'FORBIDDEN_ADMIN_ACCESS_REQUIRED',
            message: 'This operation requires administrator privileges'
        });
    }
    next();
}

/**
 * ============================================================================
 * 2. POST /api/auth/register
 * ============================================================================
 * Registers a new institutional trader account:
 * - Validates username and minimum password length
 * - Checks for duplicate username in database
 * - Generates random 10-round salt & hashes password with bcrypt
 * - Assigns role 'TRADER' and unique trader ID
 * - Issues 24-hour signed JWT token
 */
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        // A. Validation
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const trimmedUser = String(username).trim();
        if (trimmedUser.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        if (trimmedUser.toLowerCase() === 'admin') {
            return res.status(400).json({ error: 'Username "admin" is reserved' });
        }

        // B. Check for existing username
        const existing = await db.query('SELECT id FROM traders WHERE LOWER(username) = LOWER($1)', [trimmedUser]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'USERNAME_ALREADY_EXISTS' });
        }

        // C. Cryptographic Salt & Hash (10 work factor rounds)
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const traderId = `trader_${crypto.randomUUID().slice(0, 8)}`;
        const role = 'TRADER';

        // D. Persist to database
        await db.query(
            'INSERT INTO traders (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
            [traderId, trimmedUser, passwordHash, role]
        );

        // E. Seed flat initial positions & default limits for the new trader
        await db.query(`
            INSERT INTO risk_limits (trader_id, instrument, max_long, max_short, max_order_qty_outrights, max_order_qty_spreads, max_notional, trade_allowed, limit_version)
            SELECT $1, symbol, 100, 100, 50, 100, 10000000, TRUE, 1
            FROM instruments
            ON CONFLICT (trader_id, instrument) DO NOTHING;
        `, [traderId]).catch(() => {});

        await db.query(`
            INSERT INTO positions (trader_id, instrument, sod_pos, sod_px, buy_qty, sell_qty, net_pos, avg_px, realized_pl)
            SELECT $1, symbol, 0, 0, 0, 0, 0, 0, 0
            FROM instruments
            ON CONFLICT (trader_id, instrument) DO NOTHING;
        `, [traderId]).catch(() => {});

        // Sync default limits to Platform Pre-Trade Risk Gateway (Port 4002)
        const allInstruments = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];
        for (const inst of allInstruments) {
            fetch(`${PLATFORM_URL}/risk/limits`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    traderId,
                    instrument: inst,
                    maxOrderQty: 100,
                    maxPosition: 200,
                    maxNotional: 10000000
                })
            }).catch(() => {});
        }

        // F. Issue signed JWT token
        const token = jwt.sign({ id: traderId, username: trimmedUser, role }, JWT_SECRET, { expiresIn: '24h' });

        res.status(201).json({
            status: 'SUCCESS',
            token,
            user: { id: traderId, username: trimmedUser, role },
            trader: { id: traderId, username: trimmedUser, role }
        });
    } catch (err) {
        console.error('[Auth Error] /register failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 3. POST /api/auth/login
 * ============================================================================
 * Authenticates an existing trader or admin:
 * - Queries user by username
 * - Verifies raw password against stored bcrypt hash
 * - Issues a fresh 24-hour signed JWT token with role
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password, role: requestedRole } = req.body;

        // A. Validation
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const trimmedUser = String(username).trim();

        // B. Lookup user by username or ID
        const result = await db.query(
            'SELECT id, username, password_hash, role FROM traders WHERE LOWER(username) = LOWER($1) OR LOWER(id) = LOWER($1)',
            [trimmedUser]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        }

        const trader = result.rows[0];
        const role = trader.role || 'TRADER';

        // C. Verify bcrypt password hash
        const isValid = await bcrypt.compare(password, trader.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        }

        // D. Role Validation: Check if requested role matches user's actual role in DB
        if (requestedRole && role !== requestedRole) {
            return res.status(403).json({
                error: 'ROLE_MISMATCH',
                message: `Account '${trader.username}' is registered as ${role}, not ${requestedRole}`
            });
        }

        // E. Issue signed JWT
        const token = jwt.sign({ id: trader.id, username: trader.username, role }, JWT_SECRET, { expiresIn: '24h' });

        res.json({
            status: 'SUCCESS',
            token,
            user: { id: trader.id, username: trader.username, role },
            trader: { id: trader.id, username: trader.username, role }
        });
    } catch (err) {
        console.error('[Auth Error] /login failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

/**
 * ============================================================================
 * 4. GET /api/auth/me
 * ============================================================================
 * Protected endpoint returning the authenticated user's account details.
 */
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, username, role, created_at FROM traders WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'USER_NOT_FOUND' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('[Auth Error] /me failed:', err.message);
        res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});

// Export router as default, and helper middleware / constants as properties
module.exports = router;
module.exports.authenticateToken = authenticateToken;
module.exports.requireAdmin = requireAdmin;
module.exports.JWT_SECRET = JWT_SECRET;