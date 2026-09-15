const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const DBWriter = require('./db-writer.js');

describe('DBWriter Batch Persistence Unit & Integration Tests', () => {
    let dbWriter;

    beforeEach(() => {
        // Connect to pgBouncer on port 6432 (from our running docker-compose infrastructure)
        dbWriter = new DBWriter({
            host: 'localhost',
            port: 6432,
            database: 'open_interest',
            user: 'postgres',
            password: 'postgres'
        }, null, 5, 50); // Small batch size (5) and fast interval (50ms) for testing
    });

    after(async () => {
        if (dbWriter) {
            await dbWriter.stop();
        }
    });

    it('1. Should accumulate items in buffer and flush when batchSize threshold is reached', async () => {
        assert.strictEqual(dbWriter.tradeBuffer.length, 0);

        // Add 4 trades (batchSize is 5 -> should not flush yet)
        for (let i = 0; i < 4; i++) {
            dbWriter.addTrade({
                id: crypto.randomUUID(),
                buyerId: 'trader1',
                sellerId: 'trader2',
                instrument: 'GC Dec27',
                price: 2650.00,
                qty: 1,
                aggressorSide: 'BUY',
                bestBid: 2649.90,
                bestAsk: 2650.10,
                time: new Date().toISOString()
            });
        }

        assert.strictEqual(dbWriter.tradeBuffer.length, 4);

        // 5th trade hits threshold -> triggers flush()
        dbWriter.addTrade({
            id: crypto.randomUUID(),
            buyerId: 'trader1',
            sellerId: 'trader2',
            instrument: 'GC Dec27',
            price: 2650.00,
            qty: 1,
            aggressorSide: 'BUY',
            bestBid: 2649.90,
            bestAsk: 2650.10,
            time: new Date().toISOString()
        });

        // Allow async flush to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(dbWriter.tradeBuffer.length, 0);
    });

    it('2. Should flush buffer automatically via periodic timer', async () => {
        dbWriter.start(); // Start 50ms periodic timer

        dbWriter.addPrice({
            instrument: 'CL Dec27',
            bid: 78.40,
            ask: 78.60,
            last: 78.50,
            volume: 100,
            time: new Date().toISOString()
        });

        assert.strictEqual(dbWriter.priceBuffer.length, 1);

        // Wait 120ms (timer fires twice)
        await new Promise(resolve => setTimeout(resolve, 120));

        assert.strictEqual(dbWriter.priceBuffer.length, 0);
    });

    it('3. Should safely re-queue buffer items on database transaction error (Zero Data Loss)', async () => {
        // Create broken DBWriter targeting invalid port
        const brokenWriter = new DBWriter({
            host: 'localhost',
            port: 9999, // Invalid port
            database: 'open_interest',
            user: 'postgres',
            password: 'postgres'
        }, null, 500, 1000);

        const testTrade = {
            id: crypto.randomUUID(),
            buyerId: 'trader1',
            sellerId: 'trader2',
            instrument: 'GC Dec27',
            price: 2650.00,
            qty: 5,
            aggressorSide: 'SELL',
            time: new Date().toISOString()
        };

        brokenWriter.addTrade(testTrade);
        assert.strictEqual(brokenWriter.tradeBuffer.length, 1);

        // Trigger flush against dead connection
        await brokenWriter.flush();

        // Must have re-queued the trade back into buffer
        assert.strictEqual(brokenWriter.tradeBuffer.length, 1);
        assert.strictEqual(brokenWriter.tradeBuffer[0].id, testTrade.id);

        await brokenWriter.stop().catch(() => { });
    });

    it('4. Should write real trades and prices into TimescaleDB and query them', async () => {
        const tradeId = crypto.randomUUID();
        const tradeTime = new Date().toISOString();

        dbWriter.addTrade({
            id: tradeId,
            buyerId: 'trader1',
            sellerId: 'trader2',
            instrument: 'SR3 Dec27',
            price: 96.035,
            qty: 15,
            aggressorSide: 'BUY',
            bestBid: 96.030,
            bestAsk: 96.040,
            time: tradeTime
        });

        await dbWriter.flush();

        // Query TimescaleDB directly to assert row was persisted
        const client = await dbWriter.pool.connect();
        try {
            const res = await client.query('SELECT id, buyer_id, seller_id, instrument, price, qty FROM trades WHERE id = $1', [tradeId]);
            assert.strictEqual(res.rows.length, 1);
            assert.strictEqual(res.rows[0].id, tradeId);
            assert.strictEqual(res.rows[0].buyer_id, 'trader1');
            assert.strictEqual(res.rows[0].seller_id, 'trader2');
            assert.strictEqual(res.rows[0].instrument, 'SR3 Dec27');
            assert.strictEqual(Number(res.rows[0].qty), 15);
        } finally {
            client.release();
        }
    });
});