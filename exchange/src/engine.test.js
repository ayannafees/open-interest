const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { OrderBook, MatchingEngineManager } = require('./engine.js');

describe('OrderBook Core Matching Engine Tests', () => {
    let book;

    beforeEach(() => {
        // Gold Futures: tickSize = 0.10
        book = new OrderBook('GC Dec27', 0.10);
    });

    it('1. Should place resting limit orders into book', () => {
        const order = {
            id: 'ord-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        };

        const { trades, events } = book.processOrder(order);

        assert.strictEqual(trades.length, 0);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].status, 'WORKING');
        assert.strictEqual(book.getBestBid(), 2650.00);
        assert.strictEqual(book.getBestAsk(), null);
    });

    it('2. Should execute exact limit match between Buyer and Seller', () => {
        // Step 1: Resting Buy Order
        book.processOrder({
            id: 'ord-buy',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        });

        // Step 2: Aggressive Sell Order
        const { trades, events } = book.processOrder({
            id: 'ord-sell',
            traderId: 'trader2',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        });

        assert.strictEqual(trades.length, 1);
        assert.strictEqual(trades[0].qty, 10);
        assert.strictEqual(trades[0].price, 2650.00);
        assert.strictEqual(trades[0].buyerId, 'trader1');
        assert.strictEqual(trades[0].sellerId, 'trader2');
        assert.strictEqual(trades[0].aggressorSide, 'SELL');

        // Both orders should be FILLED
        const filledEvents = events.filter(e => e.status === 'FILLED');
        assert.strictEqual(filledEvents.length, 2);
        assert.strictEqual(book.getBestBid(), null);
    });

    it('3. Should sweep multi-level asks (walking the book)', () => {
        // Level 1: 5 lots @ 2650.10
        book.processOrder({
            id: 'ask-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.10,
            qty: 5,
            tif: 'DAY'
        });

        // Level 2: 10 lots @ 2650.20
        book.processOrder({
            id: 'ask-2',
            traderId: 'trader2',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.20,
            qty: 10,
            tif: 'DAY'
        });

        // Aggressive Buyer buys 12 lots
        const { trades } = book.processOrder({
            id: 'buy-sweep',
            traderId: 'trader3',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.30,
            qty: 12,
            tif: 'DAY'
        });

        assert.strictEqual(trades.length, 2);
        assert.strictEqual(trades[0].price, 2650.10);
        assert.strictEqual(trades[0].qty, 5);
        assert.strictEqual(trades[1].price, 2650.20);
        assert.strictEqual(trades[1].qty, 7);

        // Level 2 should have 3 lots remaining (10 - 7 = 3)
        const depth = book.getDepth(5);
        assert.strictEqual(depth.asks.length, 1);
        assert.strictEqual(depth.asks[0].price, 2650.20);
        assert.strictEqual(depth.asks[0].qty, 3);
    });

    it('4. Should preserve FIFO queue priority on partial fills (EX-09)', () => {
        // Trader 1 @ 2650.00 (Head of queue)
        book.processOrder({
            id: 'ord-a',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        });

        // Trader 2 @ 2650.00 (Second in line)
        book.processOrder({
            id: 'ord-b',
            traderId: 'trader2',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        });

        // Incoming Sell for 4 lots -> fills Trader 1 partially
        const match1 = book.processOrder({
            id: 'sell-1',
            traderId: 'trader3',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.00,
            qty: 4,
            tif: 'DAY'
        });
        assert.strictEqual(match1.trades[0].buyerId, 'trader1');

        // Next incoming Sell for 3 lots -> MUST fill Trader 1 again (head of line)!
        const match2 = book.processOrder({
            id: 'sell-2',
            traderId: 'trader4',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.00,
            qty: 3,
            tif: 'DAY'
        });
        assert.strictEqual(match2.trades[0].buyerId, 'trader1');
        assert.strictEqual(match2.trades[0].qty, 3);
    });

    it('5. Should block Self-Trades (EX-02)', () => {
        // Trader 1 places sell order
        book.processOrder({
            id: 'sell-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.00,
            qty: 5,
            tif: 'DAY'
        });

        // Trader 1 tries to buy own order
        const { trades, events } = book.processOrder({
            id: 'buy-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 5,
            tif: 'DAY'
        });

        assert.strictEqual(trades.length, 0); // ZERO trades executed
        const stpEvent = events.find(e => e.reason === 'STP_SELF_TRADE_PREVENTED');
        assert.ok(stpEvent);
    });

    it('6. Should enforce FOK (Fill-Or-Kill) rules', () => {
        // Only 5 lots available
        book.processOrder({
            id: 'ask-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.00,
            qty: 5,
            tif: 'DAY'
        });

        // FOK demands 10 lots -> Kills with 0 fill
        const { trades, events } = book.processOrder({
            id: 'fok-buy',
            traderId: 'trader2',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'FOK'
        });

        assert.strictEqual(trades.length, 0);
        assert.strictEqual(events[0].status, 'REJECTED');
        assert.strictEqual(events[0].reason, 'FOK_INSUFFICIENT_LIQUIDITY');
    });

    it('7. Should cancel resting orders safely (EX-03)', () => {
        book.processOrder({
            id: 'cxl-target',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        });

        const cxlResult = book.cancelOrder('cxl-target');
        assert.strictEqual(cxlResult.success, true);
        assert.strictEqual(cxlResult.event.status, 'CANCELLED');
        assert.strictEqual(book.getBestBid(), null);

        // Second cancel attempt should safely reject
        const secondCxl = book.cancelOrder('cxl-target');
        assert.strictEqual(secondCxl.success, false);
        assert.strictEqual(secondCxl.event.status, 'CANCEL_REJECTED');
    });
});