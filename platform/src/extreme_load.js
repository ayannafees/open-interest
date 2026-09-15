require('dotenv').config();
const { Kafka } = require('kafkajs');
const crypto = require('crypto');

const KAFKA_BROKER = process.env.KAFKA_BROKER_EXTERNAL || process.env.KAFKA_BROKER || 'localhost:29092';

async function runExtremeLoadTest(totalOrders = 10000, batchSize = 250) {
    console.log(`\n================================================================`);
    console.log(`⚡ OPEN INTEREST — 10,000+ OPS EXTREME LOAD BENCHMARK`);
    console.log(`================================================================`);
    console.log(`Target Volume:   ${totalOrders.toLocaleString()} Orders`);
    console.log(`Batch Size:      ${batchSize} orders per TCP packet`);
    console.log(`Kafka Cluster:   ${KAFKA_BROKER}\n`);

    const instruments = [
        { symbol: 'GC Dec27', basePrice: 2650.00, tickSize: 0.10 },
        { symbol: 'CL Dec27', basePrice: 78.50, tickSize: 0.01 },
        { symbol: 'SR3 Dec27', basePrice: 96.035, tickSize: 0.005 },
        { symbol: 'CRA Dec27', basePrice: 95.820, tickSize: 0.005 },
        { symbol: 'ER3 Jun26', basePrice: 97.210, tickSize: 0.005 }
    ];

    const traders = [
        'trader1', 'trader2', 'trader_hft_alpha', 'trader_hft_beta',
        'trader_quant_fund', 'trader_arbitrage_bot', 'trader_pension_fund'
    ];

    const kafka = new Kafka({
        clientId: 'extreme-load-tester',
        brokers: [KAFKA_BROKER]
    });

    const producer = kafka.producer();
    await producer.connect();
    console.log(`[LoadTester] ✅ Producer connected to Kafka`);

    // Pre-generate 10,000 orders in memory
    console.log(`[LoadTester] 🚀 Generating ${totalOrders.toLocaleString()} orders in RAM...`);
    const allMessages = [];

    for (let i = 0; i < totalOrders; i++) {
        const inst = instruments[i % instruments.length];
        const trader = traders[i % traders.length];
        const isBuy = i % 2 === 0;
        const tickOffset = (i % 7) - 3;
        const price = Number((inst.basePrice + (tickOffset * inst.tickSize)).toFixed(5));
        const qty = (i % 8) + 1;

        allMessages.push({
            key: inst.symbol,
            value: JSON.stringify({
                id: `ext-${crypto.randomUUID().slice(0, 8)}`,
                traderId: trader,
                instrument: inst.symbol,
                side: isBuy ? 'BUY' : 'SELL',
                type: 'LIMIT',
                price,
                qty,
                tif: 'DAY',
                timestamp: new Date().toISOString()
            })
        });
    }

    console.log(`[LoadTester] 🔥 Starting Pipeline Flood...`);
    const startTime = Date.now();

    // Send in parallel batched chunks
    const promises = [];
    for (let i = 0; i < allMessages.length; i += batchSize) {
        const chunk = allMessages.slice(i, i + batchSize);
        promises.push(
            producer.send({
                topic: 'orders',
                messages: chunk
            })
        );
    }

    await Promise.all(promises);
    const totalDurationSec = (Date.now() - startTime) / 1000;
    const throughputOPS = (totalOrders / totalDurationSec).toFixed(1);

    console.log(`\n================================================================`);
    console.log(`🏆 EXTREME BENCHMARK RESULTS`);
    console.log(`================================================================`);
    console.log(`Total Orders Fired:   ${totalOrders.toLocaleString()} Orders`);
    console.log(`Total Elapsed Time:   ${totalDurationSec.toFixed(3)} seconds`);
    console.log(`⚡ PEAK THROUGHPUT:   ${Number(throughputOPS).toLocaleString()} ORDERS / SECOND!`);
    console.log(`================================================================\n`);

    await producer.disconnect();
    process.exit(0);
}

// Run 10,000 orders in batches of 250
const count = parseInt(process.argv[2], 10) || 10000;
const batch = parseInt(process.argv[3], 10) || 250;

runExtremeLoadTest(count, batch).catch(err => {
    console.error('[LoadTester Fatal]:', err);
    process.exit(1);
});