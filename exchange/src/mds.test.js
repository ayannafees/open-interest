const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { MatchingEngineManager } = require('./engine.js');
const MDS = require('./mds.js');

describe('MDS (Market Data Server) Unit Tests', () => {
    let engineManager;
    let mds;
    let mockKafkaMessages;
    let mockProducer;

    beforeEach(() => {
        engineManager = new MatchingEngineManager();
        engineManager.registerInstrument('GC Dec27', 0.10);
        engineManager.registerInstrument('CL Dec27', 0.01);
        engineManager.registerInstrument('SR3 Dec27', 0.005);
        engineManager.registerInstrument('CRA Dec27', 0.005);
        engineManager.registerInstrument('ER3 Jun26', 0.005);

        mockKafkaMessages = [];
        mockProducer = {
            send: async ({ topic, messages }) => {
                mockKafkaMessages.push({ topic, messages });
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        mds = new MDS(engineManager, mockProducer, 'RANDOM_WALK');
    });

    it('1. Should inject 10-level liquidity (5 Bids + 5 Asks) into order book', () => {
        const goldInst = mds.instruments.get('GC Dec27');
        mds.injectMarketMakerLiquidity(goldInst);

        const book = engineManager.getBook('GC Dec27');
        const depth = book.getDepth(10);

        assert.strictEqual(depth.bids.length, 5);
        assert.strictEqual(depth.asks.length, 5);
        assert.ok(depth.bestBid < goldInst.currentPrice);
        assert.ok(depth.bestAsk > goldInst.currentPrice);

        const spread = Number((depth.bestAsk - depth.bestBid).toFixed(5));
        assert.strictEqual(spread, 0.20);
    });

    it('2. Should maintain discrete tick alignment and stay within price clamps', () => {
        const sofrInst = mds.instruments.get('SR3 Dec27');

        for (let i = 0; i < 100; i++) {
            const newPrice = mds.calculateNextPrice(sofrInst);
            const tickCount = newPrice / sofrInst.tickSize;
            const isExactTick = Math.abs(tickCount - Math.round(tickCount)) < 0.00001;
            assert.ok(isExactTick, `Price ${newPrice} is not aligned to tick size ${sofrInst.tickSize}`);

            assert.ok(newPrice >= sofrInst.basePrice * 0.90);
            assert.ok(newPrice <= sofrInst.basePrice * 1.10);
        }
    });

    it('3. Should cancel and replace old quotes on subsequent ticks (zero ghost orders)', () => {
        const goldInst = mds.instruments.get('GC Dec27');
        const book = engineManager.getBook('GC Dec27');

        mds.injectMarketMakerLiquidity(goldInst);
        assert.strictEqual(goldInst.activeQuotes.length, 10);
        assert.strictEqual(book.orders.size, 10);

        goldInst.currentPrice = 2655.00;

        mds.injectMarketMakerLiquidity(goldInst);
        assert.strictEqual(goldInst.activeQuotes.length, 10);
        assert.strictEqual(book.orders.size, 10);

        const depth = book.getDepth(10);
        assert.strictEqual(depth.bestBid, 2654.90);
        assert.strictEqual(depth.bestAsk, 2655.10);
    });

    it('4. Should generate and publish priceUpdate payloads for all 5 instruments on tick()', async () => {
        const priceUpdates = await mds.tick();

        assert.strictEqual(priceUpdates.length, 5);
        const goldUpdate = priceUpdates.find(p => p.instrument === 'GC Dec27');
        assert.ok(goldUpdate);
        assert.strictEqual(typeof goldUpdate.bid, 'number');
        assert.strictEqual(typeof goldUpdate.ask, 'number');
        assert.strictEqual(typeof goldUpdate.last, 'number');
        assert.strictEqual(typeof goldUpdate.volume, 'number');
        assert.ok(goldUpdate.time);

        assert.strictEqual(mockKafkaMessages.length, 5);
        for (const msg of mockKafkaMessages) {
            assert.strictEqual(msg.topic, 'prices');
            const parsedValue = JSON.parse(msg.messages[0].value);
            assert.strictEqual(parsedValue.instrument, msg.messages[0].key);
        }
    });

    it('5. Should support USER_DRIVEN mode (no random walk or synthetic quote injection)', async () => {
        const userDrivenMds = new MDS(engineManager, mockProducer, 'USER_DRIVEN');
        const goldInst = userDrivenMds.instruments.get('GC Dec27');
        const originalPrice = goldInst.currentPrice;

        await userDrivenMds.tick();

        assert.strictEqual(goldInst.currentPrice, originalPrice);
        const book = engineManager.getBook('GC Dec27');
        assert.strictEqual(book.orders.size, 0);
    });
});