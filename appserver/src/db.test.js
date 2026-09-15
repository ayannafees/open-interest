const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const db = require('./db.js');

describe('Database Connection Pool Tests (pgBouncer Port 6432)', () => {
    before(async () => {
        await db.initDb();
    });

    it('1. Should execute ping query successfully through pgBouncer', async () => {
        const res = await db.query('SELECT 1 AS alive');
        assert.strictEqual(res.rows.length, 1);
        assert.strictEqual(res.rows[0].alive, 1);
    });

    it('2. Should query existing seeded traders table in TimescaleDB', async () => {
        const res = await db.query('SELECT id, username FROM traders WHERE username = $1', ['trader1']);
        assert.ok(Array.isArray(res.rows));
        assert.strictEqual(res.rows.length, 1, 'Expected trader1 in database');
        assert.strictEqual(res.rows[0].id, 'trader1');
    });

    it('3. Should safely execute parameterized query with $1 placeholder', async () => {
        const res = await db.query('SELECT id, username FROM traders WHERE username = $1', ['trader1']);
        assert.strictEqual(res.rows.length, 1);
        assert.strictEqual(res.rows[0].username, 'trader1');
    });
});