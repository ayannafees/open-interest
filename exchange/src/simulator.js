require('dotenv').config();
const { Kafka } = require('kafkajs');
const crypto = require('crypto');

const KAFKA_BROKER = process.env.KAFKA_BROKER_EXTERNAL || process.env.KAFKA_BROKER || 'localhost:29092';
const EXCHANGE_HTTP = process.env.EXCHANGE_HTTP || 'http://localhost:4001';

class TradingSimulator {
    constructor(ordersPerSecond = 50, durationSeconds = 20, mode = 'USER_DRIVEN') {
        this.targetOPS = ordersPerSecond;
        this.durationSeconds = durationSeconds;
        this.mode = mode; // 'RANDOM_WALK' or 'USER_DRIVEN'
        this.intervalMs = Math.max(1, Math.floor(1000 / ordersPerSecond));

        this.instruments = [
            { symbol: 'GC Dec27', venueTopic: 'raw_orders_comex', basePrice: 2650.00, tickSize: 0.10 },
            { symbol: 'CL Dec27', venueTopic: 'raw_orders_nymex', basePrice: 78.50, tickSize: 0.01 },
            { symbol: 'SR3 Dec27', venueTopic: 'raw_orders_cme', basePrice: 96.035, tickSize: 0.005 },
            { symbol: 'CRA Dec27', venueTopic: 'raw_orders_mx', basePrice: 95.820, tickSize: 0.005 },
            { symbol: 'ER3 Jun26', venueTopic: 'raw_orders_ice', basePrice: 97.210, tickSize: 0.005 }
        ];

        // 10 distinct simulated trader accounts
        this.traders = [
            'trader1',
            'trader2',
            'trader_hft_alpha',
            'trader_hft_beta',
            'trader_quant_fund',
            'trader_arbitrage_bot',
            'trader_market_taker_1',
            'trader_market_taker_2',
            'trader_pension_fund',
            'trader_retail_daytrader'
        ];

        this.stats = {
            ordersSent: 0,
            tradesExecuted: 0,
            cancelsSent: 0,
            startTime: null,
            activeOrderIds: []
        };

        this.kafka = new Kafka({
            clientId: 'trading-simulator',
            brokers: [KAFKA_BROKER]
        });
        this.producer = null;
        this.consumer = null;
        this.timer = null;
    }

    async start() {
        console.log(`\n======================================================`);
        console.log(`🚀 OPEN INTEREST — MULTI-TRADER SIMULATOR (${this.mode})`);
        console.log(`======================================================`);
        console.log(`MDS Operating Mode: ${this.mode} (Pure Trader vs Trader Matching)`);
        console.log(`Active Traders:     ${this.traders.length} Trader Accounts`);
        console.log(`Target Throughput:  ${this.targetOPS} orders/sec`);
        console.log(`Test Duration:      ${this.durationSeconds} seconds`);
        console.log(`Instruments:        5 contracts (COMEX, NYMEX, CME, MX, ICE)`);
        console.log(`Connecting to:      ${KAFKA_BROKER}...\n`);

        // 1. Switch MDS mode via HTTP Admin Endpoint
        try {
            await fetch(`${EXCHANGE_HTTP}/admin/mds/mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.mode })
            });
            console.log(`[Simulator] Successfully set Exchange MDS mode to: ${this.mode}\n`);
        } catch (err) {
            console.warn(`[Simulator Warning] Could not set MDS mode via HTTP:`, err.message);
        }

        // 2. Connect Kafka Producer
        this.producer = this.kafka.producer();
        await this.producer.connect();

        // 3. Connect Kafka Consumer on 'trades' topic
        this.consumer = this.kafka.consumer({ groupId: `sim-stats-group-${Date.now()}` });
        await this.consumer.connect();
        await this.consumer.subscribe({ topic: 'trades', fromBeginning: false });

        this.consumer.run({
            eachMessage: async () => {
                this.stats.tradesExecuted++;
            }
        });

        this.stats.startTime = Date.now();

        // 4. Start High-Speed Order Generation Loop
        this.timer = setInterval(() => this.fireRandomOrder(), this.intervalMs);

        // 5. Live Dashboard
        const monitorTimer = setInterval(() => this.printDashboard(), 1000);

        // 6. Shutdown after durationSeconds
        setTimeout(async () => {
            clearInterval(this.timer);
            clearInterval(monitorTimer);
            await this.stop();
        }, this.durationSeconds * 1000);
    }

    async fireRandomOrder() {
        try {
            const inst = this.instruments[Math.floor(Math.random() * this.instruments.length)];
            const trader = this.traders[Math.floor(Math.random() * this.traders.length)];
            const isBuy = Math.random() > 0.5;
            const orderId = `sim-${crypto.randomUUID().slice(0, 8)}`;

            // 10% chance of cancellation
            if (Math.random() < 0.10 && this.stats.activeOrderIds.length > 0) {
                const cxlIndex = Math.floor(Math.random() * this.stats.activeOrderIds.length);
                const targetOrder = this.stats.activeOrderIds.splice(cxlIndex, 1)[0];

                await this.producer.send({
                    topic: targetOrder.topic,
                    messages: [{
                        key: targetOrder.instrument,
                        value: JSON.stringify({
                            action: 'CANCEL',
                            orderId: targetOrder.orderId,
                            traderId: targetOrder.traderId,
                            instrument: targetOrder.instrument
                        })
                    }]
                });

                this.stats.cancelsSent++;
                return;
            }

            // In USER_DRIVEN mode: Traders quote around baseline within +/- 3 ticks
            const tickOffset = Math.floor(Math.random() * 7) - 3;
            const price = Number((inst.basePrice + (tickOffset * inst.tickSize)).toFixed(5));
            const qty = Math.floor(Math.random() * 10) + 1;
            const type = Math.random() < 0.25 ? 'MARKET' : 'LIMIT';

            await this.producer.send({
                topic: inst.venueTopic,
                messages: [{
                    key: inst.symbol,
                    value: JSON.stringify({
                        id: orderId,
                        traderId: trader,
                        instrument: inst.symbol,
                        side: isBuy ? 'BUY' : 'SELL',
                        type,
                        price,
                        qty,
                        tif: type === 'MARKET' ? 'IOC' : 'DAY'
                    })
                }]
            });

            this.stats.ordersSent++;
            if (type === 'LIMIT') {
                this.stats.activeOrderIds.push({ orderId, instrument: inst.symbol, traderId: trader, topic: inst.venueTopic });
                if (this.stats.activeOrderIds.length > 300) {
                    this.stats.activeOrderIds.shift();
                }
            }
        } catch (err) {
            console.error('[Simulator Error]:', err.message);
        }
    }

    printDashboard() {
        const elapsedSec = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        const currentOPS = (this.stats.ordersSent / (elapsedSec || 1)).toFixed(1);
        const fillRate = this.stats.ordersSent > 0
            ? ((this.stats.tradesExecuted / this.stats.ordersSent) * 100).toFixed(1)
            : 0;

        process.stdout.write(
            `\r⏱️  Elapsed: ${elapsedSec}s | ` +
            `📦 Orders Sent: ${this.stats.ordersSent} | ` +
            `⚡ Peer Matches: ${this.stats.tradesExecuted} | ` +
            `❌ Cancels: ${this.stats.cancelsSent} | ` +
            `🚀 OPS: ${currentOPS} | ` +
            `🎯 Fill Rate: ${fillRate}%`
        );
    }

    async stop() {
        console.log(`\n\n======================================================`);
        console.log(`✅ USER-DRIVEN PEER-TO-PEER SIMULATION COMPLETE`);
        console.log(`======================================================`);
        const totalTimeSec = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
        console.log(`Operating Mode:       ${this.mode}`);
        console.log(`Total Participating:  10 Trader Accounts`);
        console.log(`Total Orders Fired:   ${this.stats.ordersSent}`);
        console.log(`Total Peer Trades:    ${this.stats.tradesExecuted}`);
        console.log(`Total Order Cancels:  ${this.stats.cancelsSent}`);
        console.log(`Average Throughput:   ${(this.stats.ordersSent / totalTimeSec).toFixed(1)} orders/sec`);
        console.log(`======================================================\n`);

        if (this.producer) await this.producer.disconnect().catch(() => { });
        if (this.consumer) await this.consumer.disconnect().catch(() => { });
        process.exit(0);
    }
}

// Read arguments: node src/simulator.js [ordersPerSecond] [durationSeconds] [mode]
const targetOPS = parseInt(process.argv[2], 10) || 50;
const duration = parseInt(process.argv[3], 10) || 25;
const mode = process.argv[4] || 'USER_DRIVEN';

const sim = new TradingSimulator(targetOPS, duration, mode);
sim.start().catch(err => {
    console.error('[Simulator] Fatal error:', err);
    process.exit(1);
});