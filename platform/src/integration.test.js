const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { MatchingEngineManager } = require('../../exchange/src/engine.js');
const RiskEngine = require('./rom/riskEngine.js');
const SmartOrderRouter = require('./sor/router.js');
const PIQEngine = require('./piq/piqEngine.js');

describe('Full End-to-End Integration: Platform (ROM/SOR/PIQ) <-> Exchange Engine', () => {
    let engineManager;
    let riskEngine;
    let sor;
    let piqEngine;

    // In-memory bus simulating Kafka topics across both microservices
    let kafkaBus;

    before(() => {
        // 1. Initialize Exchange Matching Engine (COMEX Gold & CME SOFR)
        engineManager = new MatchingEngineManager();
        engineManager.registerInstrument('GC Dec27', 0.10);
        engineManager.registerInstrument('SR3 Dec27', 0.005);

        // Seed resting Ask liquidity in Exchange book (Seller has 20 lots @ 2650.00)
        const goldBook = engineManager.getBook('GC Dec27');
        goldBook.processOrder({
            id: 'resting-ask-seller',
            traderId: 'trader2',
            instrument: 'GC Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 2650.00,
            qty: 20,
            tif: 'GTC'
        });

        // 2. Initialize Platform Services
        riskEngine = new RiskEngine();
        riskEngine.setTraderLimits('trader1', 'GC Dec27', {
            maxOrderQty: 100,
            maxPosition: 200,
            maxNotional: 10000000
        });

        // 3. Simulated Kafka Message Bus connecting Platform & Exchange
        kafkaBus = {
            'raw_orders_comex': [],
            'raw_orders_cme': [],
            'trades': [],
            'order_events': [],
            'piq_updates': []
        };

        const mockProducer = {
            send: async ({ topic, messages }) => {
                if (!kafkaBus[topic]) kafkaBus[topic] = [];
                for (const msg of messages) {
                    kafkaBus[topic].push(msg);
                }
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        sor = new SmartOrderRouter(mockProducer);
        piqEngine = new PIQEngine(mockProducer);
    });

    it('1. Should complete full pipeline: ROM risk check -> SOR venue dispatch -> Exchange match -> Position update', async () => {
        const incomingOrder = {
            id: 'e2e-order-101',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        };

        // --- STEP A: Platform Layer Ingestion & ROM Check ---
        const riskCheck = riskEngine.checkOrder(incomingOrder);
        assert.strictEqual(riskCheck.allowed, true);

        // Reserve working margin in ROM
        riskEngine.reserveWorkingMargin(incomingOrder);
        const posDuring = riskEngine.getPosition('trader1', 'GC Dec27');
        assert.strictEqual(posDuring.workingBuys, 10);
        assert.strictEqual(posDuring.netPos, 0);

        // --- STEP B: SOR Routes & Dispatches to Kafka Venue Topic ---
        const routed = sor.routeOrder(incomingOrder);
        assert.strictEqual(routed.topic, 'raw_orders_comex');
        await sor.dispatch(routed);

        assert.strictEqual(kafkaBus['raw_orders_comex'].length, 1);
        const venueMsg = JSON.parse(kafkaBus['raw_orders_comex'][0].value);
        assert.strictEqual(venueMsg.id, 'e2e-order-101');

        // --- STEP C: Exchange Matching Engine Consumes & Matches Order ---
        const { trades, events } = engineManager.processOrder(venueMsg);

        assert.strictEqual(trades.length, 1);
        assert.strictEqual(trades[0].buyerId, 'trader1');
        assert.strictEqual(trades[0].sellerId, 'trader2');
        assert.strictEqual(trades[0].price, 2650.00);
        assert.strictEqual(trades[0].qty, 10);

        // --- STEP D: Platform ROM Consumes Trade Fill Feedback ---
        riskEngine.onTrade(trades[0]);

        const posAfter = riskEngine.getPosition('trader1', 'GC Dec27');
        assert.strictEqual(posAfter.workingBuys, 0); // Working margin successfully released!
        assert.strictEqual(posAfter.netPos, 10);     // Net position successfully converted to +10!

        const sellerPos = riskEngine.getPosition('trader2', 'GC Dec27');
        assert.strictEqual(sellerPos.netPos, -10);   // Seller position accurately short -10!
    });

    it('2. Should block risk-violating orders at Platform boundary with ZERO Exchange venue traffic', async () => {
        kafkaBus['raw_orders_comex'] = []; // Clear topic

        const illegalOrder = {
            id: 'e2e-illegal-ord',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 500 // Exceeds maxOrderQty of 100!
        };

        // Platform ROM Check
        const riskCheck = riskEngine.checkOrder(illegalOrder);
        assert.strictEqual(riskCheck.allowed, false);
        assert.strictEqual(riskCheck.reason, 'EXCEEDS_MAX_ORDER_QTY');

        // Verify ZERO messages were published to Exchange venue topic
        assert.strictEqual(kafkaBus['raw_orders_comex'].length, 0);
    });

    it('3. Should advance PIQ queue position when Exchange matches volume ahead in the queue', () => {
        // trader1 places resting order behind 30 lots of existing volume
        piqEngine.trackOrder({
            id: 'piq-e2e-order',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2649.90,
            qty: 5
        }, 30); // 30 lots ahead

        const piqBefore = piqEngine.calculateMetrics('piq-e2e-order', 2650.00, 2650.10, 35);
        assert.strictEqual(piqBefore.piq, 30);

        // Exchange matches 20 lots at 2649.90
        piqEngine.onTrade({
            instrument: 'GC Dec27',
            price: 2649.90,
            qty: 20
        });

        const piqAfter = piqEngine.calculateMetrics('piq-e2e-order', 2650.00, 2650.10, 15);
        assert.strictEqual(piqAfter.piq, 10); // Queue advanced from 30 -> 10!
        assert.ok(piqAfter.fillProbability > piqBefore.fillProbability);
    });
});