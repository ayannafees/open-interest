const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const PIQEngine = require('./piqEngine.js');

describe('PIQ & Fill Probability Engine Unit Tests (EX-06)', () => {
    let piq;
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

        piq = new PIQEngine(mockProducer);
    });

    it('1. Should calculate maximum fill probability for order at front of queue at top of book', () => {
        piq.trackOrder({
            id: 'piq-front-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2650.00,
            qty: 10
        }, 0);

        const metrics = piq.calculateMetrics('piq-front-1', 2650.00, 2650.10, 10);

        assert.strictEqual(metrics.piq, 0);
        assert.strictEqual(metrics.aheadQty, 0);
        assert.strictEqual(metrics.deltaTicks, 0);
        assert.strictEqual(metrics.queuePercentile, 100.0);
        assert.strictEqual(metrics.fillProbability, 1.0);
    });

    it('2. Should reduce fill probability when significant volume is ahead in the queue', () => {
        piq.trackOrder({
            id: 'piq-back-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2650.00,
            qty: 10
        }, 40);

        const metrics = piq.calculateMetrics('piq-back-1', 2650.00, 2650.10, 50);

        assert.strictEqual(metrics.piq, 40);
        assert.strictEqual(metrics.aheadQty, 40);
        assert.strictEqual(metrics.queuePercentile, 20.0);
        assert.strictEqual(metrics.fillProbability, 0.48);
    });

    it('3. Should decay fill probability exponentially as price moves ticks away from Best Bid', () => {
        piq.trackOrder({
            id: 'piq-deep-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2649.60,
            qty: 10
        }, 0);

        const metrics = piq.calculateMetrics('piq-deep-1', 2650.00, 2650.10, 10);

        assert.strictEqual(metrics.deltaTicks, 4);
        assert.ok(metrics.fillProbability < 0.40);
        assert.ok(metrics.fillProbability > 0.35);
    });

    it('4. Should decrement aheadQty/piq and improve queue position when trades occur at price level', () => {
        piq.trackOrder({
            id: 'piq-trade-test',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2650.00,
            qty: 10
        }, 30);

        let metricsBefore = piq.calculateMetrics('piq-trade-test', 2650.00, 2650.10, 40);
        assert.strictEqual(metricsBefore.piq, 30);

        piq.onTrade({
            instrument: 'GC Dec27',
            price: 2650.00,
            qty: 20
        });

        let metricsAfter = piq.calculateMetrics('piq-trade-test', 2650.00, 2650.10, 20);
        assert.strictEqual(metricsAfter.piq, 10);
        assert.ok(metricsAfter.fillProbability > metricsBefore.fillProbability);
    });

    it('5. Should automatically evict fully filled orders from all indices (Memory Leak Prevention)', () => {
        piq.trackOrder({
            id: 'piq-fill-test',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2650.00,
            qty: 15
        }, 0);

        assert.strictEqual(piq.trackedOrders.has('piq-fill-test'), true);
        assert.strictEqual(piq.ordersByLevel.get('GC Dec27:2650').has('piq-fill-test'), true);

        piq.onTrade({
            orderId: 'piq-fill-test',
            instrument: 'GC Dec27',
            price: 2650.00,
            qty: 15
        });

        assert.strictEqual(piq.trackedOrders.has('piq-fill-test'), false);
        assert.strictEqual(piq.ordersByLevel.has('GC Dec27:2650'), false);
    });

    it('6. Should cleanly evict order on CANCELLED lifecycle event', () => {
        piq.trackOrder({
            id: 'piq-cxl-test',
            traderId: 'trader1',
            instrument: 'CL Dec27',
            side: 'SELL',
            price: 78.50,
            qty: 20
        }, 10);

        assert.strictEqual(piq.trackedOrders.has('piq-cxl-test'), true);

        piq.onOrderEvent({
            orderId: 'piq-cxl-test',
            status: 'CANCELLED'
        });

        assert.strictEqual(piq.trackedOrders.has('piq-cxl-test'), false);
        assert.strictEqual(piq.ordersByLevel.has('CL Dec27:78.5'), false);
    });

    it('7. Should broadcast PIQ telemetry to Kafka piq_updates topic with traderId key', async () => {
        piq.trackOrder({
            id: 'piq-stream-1',
            traderId: 'trader_algo_1',
            instrument: 'SR3 Dec27',
            side: 'BUY',
            price: 96.035,
            qty: 15
        }, 5);

        const published = await piq.broadcastUpdate('piq-stream-1', 96.035, 96.040, 20);
        assert.ok(published);
        assert.strictEqual(published.orderId, 'piq-stream-1');
        assert.strictEqual(published.piq, 5);

        assert.strictEqual(mockKafkaMessages.length, 1);
        assert.strictEqual(mockKafkaMessages[0].topic, 'piq_updates');
        assert.strictEqual(mockKafkaMessages[0].messages[0].key, 'trader_algo_1');

        const payload = JSON.parse(mockKafkaMessages[0].messages[0].value);
        assert.strictEqual(payload.traderId, 'trader_algo_1');
        assert.strictEqual(payload.piq, 5);
    });

    it('8. Should return full PIQ telemetry via calculateMetrics and null for un-tracked orders', () => {
        piq.trackOrder({
            id: 'piq-query-test',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2650.00,
            qty: 10
        }, 25);

        const telemetry = piq.calculateMetrics('piq-query-test', 2650.00, 2650.10, 35);
        assert.ok(telemetry);
        assert.strictEqual(telemetry.orderId, 'piq-query-test');
        assert.strictEqual(telemetry.piq, 25);
        assert.strictEqual(telemetry.aheadQty, 25);
        assert.strictEqual(telemetry.remainingQty, 10);

        const unknownTelemetry = piq.calculateMetrics('non-existent-order', 2650.00, 2650.10);
        assert.strictEqual(unknownTelemetry, null);

        piq.onTrade({
            instrument: 'GC Dec27',
            price: 2650.00,
            qty: 10
        });

        const updatedTelemetry = piq.calculateMetrics('piq-query-test', 2650.00, 2650.10, 25);
        assert.strictEqual(updatedTelemetry.piq, 15);
    });

    it('9. Should accurately track FIFO queue positions for multiple orders at the exact same price and side', () => {
        // Order 1 arrives first: 1 lot @ 2638.70 BUY
        piq.trackOrder({
            id: 'ord-seq-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2638.70,
            qty: 1
        }, 0);

        // Order 2 arrives second: 1 lot @ 2638.70 BUY
        piq.trackOrder({
            id: 'ord-seq-2',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2638.70,
            qty: 1
        }, 0);

        const m1 = piq.calculateMetrics('ord-seq-1', 2640.00, 2640.10, 2);
        const m2 = piq.calculateMetrics('ord-seq-2', 2640.00, 2640.10, 2);

        // Order 1 (arrived first) -> 0 ahead, 1 behind
        assert.strictEqual(m1.aheadQty, 0);
        assert.strictEqual(m1.behindQty, 1);
        assert.strictEqual(m1.totalLevelQty, 2);

        // Order 2 (arrived second) -> 1 ahead, 0 behind
        assert.strictEqual(m2.aheadQty, 1);
        assert.strictEqual(m2.behindQty, 0);
        assert.strictEqual(m2.totalLevelQty, 2);
        assert.ok(m1.fillProbability > m2.fillProbability);
    });

    it('10. Should advance second order to front of queue when first order is cancelled', () => {
        piq.trackOrder({
            id: 'ord-cxl-1',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2638.70,
            qty: 1
        }, 0);

        piq.trackOrder({
            id: 'ord-cxl-2',
            traderId: 'trader1',
            instrument: 'GC Dec27',
            side: 'BUY',
            price: 2638.70,
            qty: 1
        }, 0);

        // Cancel order 1
        piq.onOrderEvent({
            orderId: 'ord-cxl-1',
            status: 'CANCELLED'
        });

        const m2 = piq.calculateMetrics('ord-cxl-2', 2640.00, 2640.10, 1);
        assert.strictEqual(m2.aheadQty, 0);
        assert.strictEqual(m2.behindQty, 0);
        assert.strictEqual(m2.totalLevelQty, 1);
    });
});