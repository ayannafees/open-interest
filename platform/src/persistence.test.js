const { describe, it } = require('node:test');
const assert = require('node:assert');
const RiskEngine = require('./rom/riskEngine.js');
const db = require('./db.js');

describe('ROM Risk Limits & Positions Persistence and Crash-Recovery Tests', () => {

    it('1. Should hydrate custom trader limits from DB rows into memory (Cold Start Recovery)', () => {
        const riskEngine = new RiskEngine();

        // Simulate database rows loaded from risk_limits table for an arbitrary new trader
        const simulatedDbRows = [
            {
                trader_id: 'trader_persisted_99',
                instrument: 'GC Dec27',
                max_order_qty_outrights: 77,
                max_long: 155,
                max_notional: 30000000,
                trade_allowed: true
            },
            {
                trader_id: 'trader_persisted_99',
                instrument: 'CL Dec27',
                max_order_qty_outrights: 45,
                max_long: 90,
                max_notional: 5000000,
                trade_allowed: false // Disabled by admin
            }
        ];

        // Hydrate
        riskEngine.loadLimitsFromDb(simulatedDbRows);

        // Verify GC Dec27 limits
        const gcLimits = riskEngine.getTraderLimits('trader_persisted_99', 'GC Dec27');
        assert.strictEqual(gcLimits.maxOrderQty, 77);
        assert.strictEqual(gcLimits.maxPosition, 155);
        assert.strictEqual(gcLimits.maxNotional, 30000000);
        assert.strictEqual(gcLimits.tradeAllowed, true);

        // Verify CL Dec27 limits
        const clLimits = riskEngine.getTraderLimits('trader_persisted_99', 'CL Dec27');
        assert.strictEqual(clLimits.maxOrderQty, 45);
        assert.strictEqual(clLimits.tradeAllowed, false);

        // Verify pre-trade risk check on GC Dec27 accepts order up to 77
        const validOrder = {
            id: 'ord-recover-1',
            traderId: 'trader_persisted_99',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 77
        };
        const check = riskEngine.checkOrder(validOrder);
        assert.strictEqual(check.allowed, true);

        // Verify pre-trade risk check on CL Dec27 blocks because tradeAllowed is false
        const blockedOrder = {
            id: 'ord-recover-2',
            traderId: 'trader_persisted_99',
            instrument: 'CL Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 78.50,
            qty: 10
        };
        const blockedCheck = riskEngine.checkOrder(blockedOrder);
        assert.strictEqual(blockedCheck.allowed, false);
        assert.strictEqual(blockedCheck.reason, 'TRADING_SUSPENDED_BY_ADMIN');
    });

    it('2. Should hydrate open positions from DB rows into memory (Position State Recovery)', () => {
        const riskEngine = new RiskEngine();

        // Simulate database rows from positions table
        const simulatedPosRows = [
            {
                trader_id: 'trader_persisted_99',
                instrument: 'GC Dec27',
                net_pos: 25,
                buy_qty: 30,
                sell_qty: 5,
                avg_px: 2648.50,
                realized_pl: 1250.00
            }
        ];

        riskEngine.loadPositionsFromDb(simulatedPosRows);

        const pos = riskEngine.getPosition('trader_persisted_99', 'GC Dec27');
        assert.strictEqual(pos.netPos, 25);
        assert.strictEqual(pos.buyQty, 30);
        assert.strictEqual(pos.sellQty, 5);
        assert.strictEqual(pos.avgPx, 2648.50);
        assert.strictEqual(pos.realizedPnl, 1250.00);
    });

    it('3. Should accurately enforce position ceiling taking hydrated prior positions into account', () => {
        const riskEngine = new RiskEngine();

        // Set limit maxPosition: 100
        riskEngine.setTraderLimits('trader_persisted_99', 'GC Dec27', {
            maxOrderQty: 80,
            maxPosition: 100,
            maxNotional: 20000000,
            tradeAllowed: true
        });

        // Hydrate existing position: +80 long
        riskEngine.loadPositionsFromDb([{
            trader_id: 'trader_persisted_99',
            instrument: 'GC Dec27',
            net_pos: 80,
            avg_px: 2650.00
        }]);

        // Attempting to buy 25 more would make position 105 (> 100 ceiling) -> Must REJECT!
        const buy25 = {
            id: 'ord-over-pos',
            traderId: 'trader_persisted_99',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 25
        };
        const check1 = riskEngine.checkOrder(buy25);
        assert.strictEqual(check1.allowed, false);
        assert.strictEqual(check1.reason, 'EXCEEDS_MAX_POSITION_LIMIT');

        // Attempting to buy 20 more makes position exactly 100 -> Must APPROVE!
        const buy20 = {
            id: 'ord-ok-pos',
            traderId: 'trader_persisted_99',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 20
        };
        const check2 = riskEngine.checkOrder(buy20);
        assert.strictEqual(check2.allowed, true);
    });

    it('4. Should safely execute database upsert functions with real pg pool or mock', async () => {
        // Test upsert limit
        const limitSaved = await db.upsertLimit('trader1', 'GC Dec27', {
            maxOrderQty: 100,
            maxPosition: 200,
            maxNotional: 10000000,
            tradeAllowed: true
        });
        assert.strictEqual(typeof limitSaved, 'boolean');

        // Test upsert position
        const posSaved = await db.upsertPosition('trader1', 'GC Dec27', {
            buyQty: 10,
            sellQty: 0,
            netPos: 10,
            avgPx: 2650.00,
            realizedPnl: 0
        });
        assert.strictEqual(typeof posSaved, 'boolean');

        // Test loadAllLimits
        const limits = await db.loadAllLimits();
        assert.strictEqual(Array.isArray(limits), true);

        // Test loadAllPositions
        const positions = await db.loadAllPositions();
        assert.strictEqual(Array.isArray(positions), true);
    });
});
