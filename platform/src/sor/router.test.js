const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const SmartOrderRouter = require('./router.js');

describe('Smart Order Router (SOR) Unit Tests (EX-05 & Dead-Letter Guard)', () => {
    let router;
    let mockKafkaMessages;
    let mockProducer;

    beforeEach(() => {
        mockKafkaMessages = [];
        mockProducer = {
            send: async ({ topic, messages }) => {
                mockKafkaMessages.push({ topic, messages });
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        router = new SmartOrderRouter(mockProducer);
    });

    it('1. Should route Gold (GC Dec27) to raw_orders_comex venue topic (EX-05)', () => {
        const order = {
            id: 'ord-gold-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 5,
            tif: 'DAY'
        };

        const routed = router.routeOrder(order);
        assert.strictEqual(routed.isDeadLetter, false);
        assert.strictEqual(routed.topic, 'raw_orders_comex');
        assert.strictEqual(routed.exchange, 'COMEX');
        assert.strictEqual(routed.payload.id, 'ord-gold-1');
        assert.strictEqual(routed.payload.qty, 5);
    });

    it('2. Should route Crude Oil (CL Dec27) to raw_orders_nymex venue topic (EX-05)', () => {
        const order = {
            id: 'ord-oil-1',
            traderId: 'trader1',
            instrument: 'CL Dec27',
            side: 'SELL',
            type: 'LIMIT',
            price: 78.50,
            qty: 10,
            tif: 'GTC'
        };

        const routed = router.routeOrder(order);
        assert.strictEqual(routed.isDeadLetter, false);
        assert.strictEqual(routed.topic, 'raw_orders_nymex');
        assert.strictEqual(routed.exchange, 'NYMEX');
    });

    it('3. Should route SOFR Rate (SR3 Dec27) to raw_orders_cme venue topic (EX-05)', () => {
        const order = {
            id: 'ord-sofr-1',
            traderId: 'trader2',
            instrument: 'SR3 Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 96.035,
            qty: 25,
            tif: 'DAY'
        };

        const routed = router.routeOrder(order);
        assert.strictEqual(routed.isDeadLetter, false);
        assert.strictEqual(routed.topic, 'raw_orders_cme');
        assert.strictEqual(routed.exchange, 'CME');
    });

    it('4. Should route CORRA Rate (CRA Dec27) to raw_orders_mx venue topic (EX-05)', () => {
        const order = {
            id: 'ord-cra-1',
            traderId: 'trader1',
            instrument: 'CRA Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 95.820,
            qty: 15,
            tif: 'DAY'
        };

        const routed = router.routeOrder(order);
        assert.strictEqual(routed.isDeadLetter, false);
        assert.strictEqual(routed.topic, 'raw_orders_mx');
        assert.strictEqual(routed.exchange, 'MX');
    });

    it('5. Should route €STR Rate (ER3 Jun26) to raw_orders_ice venue topic (EX-05)', () => {
        const order = {
            id: 'ord-er3-1',
            traderId: 'trader2',
            instrument: 'ER3 Jun26',
            side: 'SELL',
            type: 'LIMIT',
            price: 97.210,
            qty: 8,
            tif: 'DAY'
        };

        const routed = router.routeOrder(order);
        assert.strictEqual(routed.isDeadLetter, false);
        assert.strictEqual(routed.topic, 'raw_orders_ice');
        assert.strictEqual(routed.exchange, 'ICE');
    });

    it('6. Should route unknown instrument to dead_letter topic and emit REJECTED event', async () => {
        const order = {
            id: 'bad-sym-1',
            traderId: 'trader1',
            instrument: 'UNKNOWN_CRYPTO',
            side: 'BUY',
            qty: 1
        };

        const routed = router.routeOrder(order);
        assert.strictEqual(routed.isDeadLetter, true);
        assert.strictEqual(routed.topic, 'dead_letter');
        assert.strictEqual(routed.rejectionEvent.reason, 'UNKNOWN_VENUE');

        // Dispatch and verify Kafka publications
        const res = await router.dispatch(routed);
        assert.strictEqual(res.status, 'DEAD_LETTERED');
        assert.strictEqual(res.topic, 'dead_letter');

        // Must have sent 2 messages: 1 to dead_letter, 1 to order_events
        assert.strictEqual(mockKafkaMessages.length, 2);
        assert.strictEqual(mockKafkaMessages[0].topic, 'dead_letter');
        assert.strictEqual(mockKafkaMessages[1].topic, 'order_events');

        const eventPayload = JSON.parse(mockKafkaMessages[1].messages[0].value);
        assert.strictEqual(eventPayload.status, 'REJECTED');
        assert.strictEqual(eventPayload.reason, 'UNKNOWN_VENUE');
    });

    it('7. Should route CANCEL action to correct venue topic', () => {
        const cxlReq = {
            orderId: 'ord-gold-1',
            traderId: 'trader1',
            instrument: 'GC Dec27'
        };

        const routed = router.routeCancel(cxlReq);
        assert.strictEqual(routed.isDeadLetter, false);
        assert.strictEqual(routed.topic, 'raw_orders_comex');
        assert.strictEqual(routed.payload.action, 'CANCEL');
        assert.strictEqual(routed.payload.orderId, 'ord-gold-1');
    });

    it('8. Should dispatch routed order package to Kafka with instrument key', async () => {
        const routed = router.routeOrder({
            id: 'dispatch-test-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 2
        });

        const res = await router.dispatch(routed);
        assert.strictEqual(res.status, 'DISPATCHED');
        assert.strictEqual(res.topic, 'raw_orders_comex');

        assert.strictEqual(mockKafkaMessages.length, 1);
        assert.strictEqual(mockKafkaMessages[0].topic, 'raw_orders_comex');
        assert.strictEqual(mockKafkaMessages[0].messages[0].key, 'GC Dec27');
    });
});