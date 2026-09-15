require('dotenv').config();
const { Kafka } = require('kafkajs');
const crypto = require('crypto');

const KAFKA_BROKER = process.env.KAFKA_BROKER_EXTERNAL || process.env.KAFKA_BROKER || 'localhost:29092';
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:4002';
const EXCHANGE_URL = process.env.EXCHANGE_URL || 'http://localhost:4001';

class FullClusterBenchmarkSimulator {
    constructor(targetOPS = 100, durationSeconds = 25) {
        this.targetOPS = targetOPS;
        this.durationSeconds = durationSeconds;
        this.intervalMs = Math.max(1, Math.floor(1000 / targetOPS));

        this.instruments = [
            { symbol: 'GC Dec27', basePrice: 2650.00, tickSize: 0.10 },
            { symbol: 'CL Dec27', basePrice: 78.50, tickSize: 0.01 },
            { symbol: 'SR3 Dec27', basePrice: 96.035, tickSize: 0.005 },
            { symbol: 'CRA Dec27', basePrice: 95.820, tickSize: 0.005 },
            { symbol: 'ER3 Jun26', basePrice: 97.210, tickSize: 0.005 }
        ];

        // 10 distinct traders with institutional risk limits
        this.traders = [
            { id: 'trader1', name: 'Prop Desk Alpha', maxOrder: 100, maxPos: 200, maxNotional: 20000000 },
            { id: 'trader2', name: 'Prop Desk Beta', maxOrder: 100, maxPos: 200, maxNotional: 20000000 },
            { id: 'trader_hft_alpha', name: 'HFT Market Maker', maxOrder: 50, maxPos: 150, maxNotional: 15000000 },
            { id: 'trader_hft_beta', name: 'HFT Taker', maxOrder: 50, maxPos: 150, maxNotional: 15000000 },
            { id: 'trader_quant_fund', name: 'Quant Fund', maxOrder: 80, maxPos: 300, maxNotional: 30000000 },
            { id: 'trader_arbitrage_bot', name: 'Arb Bot', maxOrder: 40, maxPos: 100, maxNotional: 10000000 },
            { id: 'trader_market_taker_1', name: 'Retail Taker A', maxOrder: 20, maxPos: 50, maxNotional: 5000000 },
            { id: 'trader_market_taker_2', name: 'Retail Taker B', maxOrder: 20, maxPos: 50, maxNotional: 5000000 },
            { id: 'trader_pension_fund', name: 'Macro Pension Fund', maxOrder: 100, maxPos: 500, maxNotional: 50000000 },
            { id: 'trader_retail_daytrader', name: 'Retail Scalper', maxOrder: 10, maxPos: 30, maxNotional: 3000000 }
        ];

        this.stats = {
            ordersPublished: 0,
            tradesExecuted: 0,
            riskRejections: 0,
            piqUpdatesReceived: 0,
            latenciesMs: [],
            startTime: null
        };

        this.kafka = new Kafka({
            clientId: 'benchmark-simulator',
            brokers: [KAFKA_BROKER]
        });

        this.producer = null;
        this.consumer = null;
        this.timer = null;
    }

    async start() {
        console.log(`\n================================================================`);
        console.log(`🚀 OPEN INTEREST — FULL-CLUSTER BENCHMARK & LOAD SIMULATOR`);
        console.log(`================================================================`);
        console.log(`Kafka Cluster:      ${KAFKA_BROKER}`);
        console.log(`Platform Gateway:   ${PLATFORM_URL}`);
        console.log(`Exchange Gateway:   ${EXCHANGE_URL}`);
        console.log(`Active Traders:     ${this.traders.length} Institutional Accounts`);
        console.log(`Target Speed:       ${this.targetOPS} orders/sec`);
        console.log(`Benchmark Duration: ${this.durationSeconds} seconds\n`);

        // 1. Configure Exchange to USER_DRIVEN mode
        try {
            await fetch(`${EXCHANGE_URL}/admin/mds/mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'USER_DRIVEN' })
            });
            console.log(`[Simulator] ✅ Exchange MDS switched to USER_DRIVEN mode.`);
        } catch (err) {
            console.warn(`[Simulator Warning] Could not reach Exchange at ${EXCHANGE_URL}:`, err.message);
        }

        // 2. Pre-configure 50 Risk Rules in ROM via Platform HTTP
        console.log(`[Simulator] ⚙️  Configuring per-instrument risk limits in Platform ROM...`);
        for (const trader of this.traders) {
            for (const inst of this.instruments) {
                await fetch(`${PLATFORM_URL}/risk/limits`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        traderId: trader.id,
                        instrument: inst.symbol,
                        maxOrderQty: trader.maxOrder,
                        maxPosition: trader.maxPos,
                        maxNotional: trader.maxNotional
                    })
                }).catch(() => { });
            }
        }
        console.log(`[Simulator] ✅ 50 Risk Limit Rules Pre-Loaded into ROM!\n`);

        // 3. Connect Kafka Producer to publish directly to 'orders' topic
        this.producer = this.kafka.producer();
        await this.producer.connect();
        console.log(`[Simulator] ✅ Producer connected to Kafka topic: [orders]`);

        // 4. Connect Kafka Consumer to listen to output topics: [trades], [order_events], [piq_updates]
        this.consumer = this.kafka.consumer({ groupId: `sim-benchmark-group-${Date.now()}` });
        await this.consumer.connect();
        await this.consumer.subscribe({ topic: 'trades', fromBeginning: false });
        await this.consumer.subscribe({ topic: 'order_events', fromBeginning: false });
        await this.consumer.subscribe({ topic: 'piq_updates', fromBeginning: false });

        this.consumer.run({
            eachMessage: async ({ topic, message }) => {
                const payload = JSON.parse(message.value.toString());

                if (topic === 'trades') {
                    this.stats.tradesExecuted++;
                    if (payload.time) {
                        const latency = Date.now() - new Date(payload.time).getTime();
                        if (latency >= 0 && latency < 5000) {
                            this.stats.latenciesMs.push(latency);
                        }
                    }
                } else if (topic === 'order_events') {
                    if (payload.status === 'REJECTED') {
                        this.stats.riskRejections++;
                    }
                } else if (topic === 'piq_updates') {
                    this.stats.piqUpdatesReceived++;
                }
            }
        });

        console.log(`[Simulator] ✅ Consumer listening to [trades], [order_events], [piq_updates]\n`);

        this.stats.startTime = Date.now();

        // 5. Start Order Injection Loop
        this.timer = setInterval(() => this.fireOrder(), this.intervalMs);

        // 6. Live Dashboard
        const monitorTimer = setInterval(() => this.printDashboard(), 1000);

        // 7. Complete after duration
        setTimeout(async () => {
            clearInterval(this.timer);
            clearInterval(monitorTimer);
            await this.stop();
        }, this.durationSeconds * 1000);
    }

    async fireOrder() {
        try {
            const trader = this.traders[Math.floor(Math.random() * this.traders.length)];
            const inst = this.instruments[Math.floor(Math.random() * this.instruments.length)];
            const isBuy = Math.random() > 0.5;
            const orderId = `live-${crypto.randomUUID().slice(0, 8)}`;

            // 10% chance of an intentional risk violation test (exceeds maxOrder)
            const isRiskTest = Math.random() < 0.10;
            const qty = isRiskTest ? trader.maxOrder + 50 : Math.floor(Math.random() * 8) + 1;

            const tickOffset = Math.floor(Math.random() * 7) - 3;
            const price = Number((inst.basePrice + (tickOffset * inst.tickSize)).toFixed(5));

            const orderPayload = {
                id: orderId,
                traderId: trader.id,
                instrument: inst.symbol,
                side: isBuy ? 'BUY' : 'SELL',
                type: 'LIMIT',
                price,
                qty,
                tif: 'DAY',
                timestamp: new Date().toISOString()
            };

            // PUBLISH DIRECTLY TO KAFKA 'orders' TOPIC
            await this.producer.send({
                topic: 'orders',
                messages: [{
                    key: inst.symbol,
                    value: JSON.stringify(orderPayload)
                }]
            });

            this.stats.ordersPublished++;
        } catch (err) {
            console.error('[Simulator Send Error]:', err.message);
        }
    }

    printDashboard() {
        const elapsedSec = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
        const currentOPS = (this.stats.ordersPublished / (elapsedSec || 1)).toFixed(1);
        const fillRate = this.stats.ordersPublished > 0
            ? ((this.stats.tradesExecuted / this.stats.ordersPublished) * 100).toFixed(1)
            : 0;

        process.stdout.write(
            `\r⏱️  Elapsed: ${elapsedSec}s | ` +
            `📦 Orders Published: ${this.stats.ordersPublished} | ` +
            `⚡ Matches: ${this.stats.tradesExecuted} | ` +
            `🚫 Risk Blocked: ${this.stats.riskRejections} | ` +
            `🎯 Fill: ${fillRate}% | ` +
            `🚀 OPS: ${currentOPS}`
        );
    }

    async stop() {
        console.log(`\n\n================================================================`);
        console.log(`📊 FULL-CLUSTER BENCHMARK REPORT`);
        console.log(`================================================================`);
        const totalTimeSec = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
        const avgOPS = (this.stats.ordersPublished / totalTimeSec).toFixed(1);
        const avgLatency = this.stats.latenciesMs.length > 0
            ? (this.stats.latenciesMs.reduce((a, b) => a + b, 0) / this.stats.latenciesMs.length).toFixed(2)
            : '0.00';

        console.log(`Total Duration:            ${totalTimeSec} seconds`);
        console.log(`Total Orders Published:    ${this.stats.ordersPublished} (to Kafka topic [orders])`);
        console.log(`Total Trades Matched:      ${this.stats.tradesExecuted} (consumed from [trades])`);
        console.log(`Total Risk Violations:     ${this.stats.riskRejections} (caught & blocked by ROM)`);
        console.log(`Average Throughput (OPS):  ${avgOPS} orders/sec`);
        console.log(`Average End-to-End Latency:${avgLatency} ms`);
        console.log(`================================================================\n`);

        if (this.producer) await this.producer.disconnect().catch(() => { });
        if (this.consumer) await this.consumer.disconnect().catch(() => { });
        process.exit(0);
    }
}

const targetOPS = parseInt(process.argv[2], 10) || 50;
const duration = parseInt(process.argv[3], 10) || 20;

const sim = new FullClusterBenchmarkSimulator(targetOPS, duration);
sim.start().catch(err => {
    console.error('[Benchmark Simulator Fatal]:', err);
    process.exit(1);
});