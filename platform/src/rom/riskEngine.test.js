const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const RiskEngine = require('./riskEngine.js');

describe('ROM Pre-Trade Risk Engine Unit Tests (Per-Instrument Limits)', () => {
    let riskEngine;

    beforeEach(() => {
        riskEngine = new RiskEngine();
        // Configure specific limits for GC Dec27 with generous notional for testing position limits
        riskEngine.setTraderLimits('trader_custom', 'GC Dec27', {
            maxOrderQty: 50,
            maxPosition: 100,
            maxNotional: 20000000 // $20,000,000 max
        });
    });

    it('1. Should APPROVE valid order within per-instrument limits', () => {
        const order = {
            id: 'ord-1',
            traderId: 'trader_custom',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 2
        };

        const check = riskEngine.checkOrder(order);
        assert.strictEqual(check.allowed, true);
    });

    it('2. Should REJECT order on unconfigured instrument (Strict Zero-Trust Default)', () => {
        // trader_custom has NO limits configured on Crude Oil (CL Dec27)
        const order = {
            id: 'ord-unconfigured',
            traderId: 'trader_custom',
            instrument: 'CL Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 78.50,
            qty: 5
        };

        const check = riskEngine.checkOrder(order);
        assert.strictEqual(check.allowed, false);
        assert.strictEqual(check.reason, 'NO_RISK_LIMITS_CONFIGURED');
    });

    it('3. Should REJECT order exceeding max single order quantity for that instrument', () => {
        const order = {
            id: 'ord-2',
            traderId: 'trader_custom',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 60 // Limit is 50
        };

        const check = riskEngine.checkOrder(order);
        assert.strictEqual(check.allowed, false);
        assert.strictEqual(check.reason, 'EXCEEDS_MAX_ORDER_QTY');
    });

    it('4. Should REJECT order exceeding max position limit with working order reservation (ROM-01)', () => {
        const ord1 = { id: 'ord-w1', traderId: 'trader_custom', instrument: 'GC Dec27', side: 'BUY', qty: 40, price: 2650.00 };
        assert.strictEqual(riskEngine.checkOrder(ord1).allowed, true);
        riskEngine.reserveWorkingMargin(ord1);

        const ord2 = { id: 'ord-w2', traderId: 'trader_custom', instrument: 'GC Dec27', side: 'BUY', qty: 40, price: 2650.00 };
        assert.strictEqual(riskEngine.checkOrder(ord2).allowed, true);
        riskEngine.reserveWorkingMargin(ord2);

        // 80 working + 30 new = 110 > 100 limit!
        const ord3 = { id: 'ord-w3', traderId: 'trader_custom', instrument: 'GC Dec27', side: 'BUY', qty: 30, price: 2650.00 };
        const check = riskEngine.checkOrder(ord3);

        assert.strictEqual(check.allowed, false);
        assert.strictEqual(check.reason, 'EXCEEDS_MAX_POSITION_LIMIT');
    });

    it('5. Should REJECT order exceeding max notional value for that contract (ROM-02)', () => {
        // Set a small notional limit ($1,000,000) for this test
        riskEngine.setTraderLimits('trader_custom', 'GC Dec27', {
            maxOrderQty: 50,
            maxPosition: 100,
            maxNotional: 1000000 // $1,000,000
        });

        // 10 Gold contracts @ $2650 * 100 multiplier = $2,650,000 notional (exceeds $1,000,000)
        const order = {
            id: 'ord-notional',
            traderId: 'trader_custom',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10
        };

        const check = riskEngine.checkOrder(order);
        assert.strictEqual(check.allowed, false);
        assert.strictEqual(check.reason, 'EXCEEDS_MAX_NOTIONAL_LIMIT');
    });

    it('6. Should convert working reservations into real net position on trade fill', () => {
        const ord = { id: 'ord-fill-1', traderId: 'trader_custom', instrument: 'GC Dec27', side: 'BUY', qty: 20, price: 2650.00 };
        riskEngine.reserveWorkingMargin(ord);

        const posBefore = riskEngine.getPosition('trader_custom', 'GC Dec27');
        assert.strictEqual(posBefore.workingBuys, 20);
        assert.strictEqual(posBefore.netPos, 0);

        riskEngine.onTrade({
            id: 'trd-1',
            buyerId: 'trader_custom',
            sellerId: 'trader2',
            instrument: 'GC Dec27',
            price: 2650.00,
            qty: 20
        });

        assert.strictEqual(posBefore.workingBuys, 0);
        assert.strictEqual(posBefore.netPos, 20);

        const posAfter = riskEngine.getPosition('trader_custom', 'GC Dec27');
        assert.strictEqual(posAfter.workingBuys, 0);
        assert.strictEqual(posAfter.netPos, 20);
    });

    it('7. Should release reserved working margin when an order is CANCELLED', () => {
        const ord = { id: 'ord-cxl-1', traderId: 'trader_custom', instrument: 'GC Dec27', side: 'BUY', qty: 35, price: 2650.00 };
        riskEngine.reserveWorkingMargin(ord);

        const posBefore = riskEngine.getPosition('trader_custom', 'GC Dec27');
        assert.strictEqual(posBefore.workingBuys, 35);

        riskEngine.onOrderEvent({
            orderId: 'ord-cxl-1',
            status: 'CANCELLED',
            remainingQty: 35
        });

        const posAfter = riskEngine.getPosition('trader_custom', 'GC Dec27');
        assert.strictEqual(posAfter.workingBuys, 0);
    });
});