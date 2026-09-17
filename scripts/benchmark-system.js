/**
 * Open Interest — Comprehensive System Extreme Limits & Benchmark Suite
 *
 * Measures sub-microsecond latency profiles, peak orders-per-second (OPS),
 * and memory utilization across:
 *   1. Core In-Memory Matching Engine (Double-Auction FIFO)
 *   2. Pre-Trade Risk Engine (ROM)
 *   3. Smart Order Router (SOR)
 *   4. Position-In-Queue Engine (PIQ)
 *   5. Full Integrated Execution Pipeline (End-to-End Microservices Loop)
 */

const { performance } = require('perf_hooks');
const crypto = require('crypto');
const path = require('path');

// Import platform modules
const { MatchingEngineManager, OrderBook } = require('../exchange/src/engine.js');
const RiskEngine = require('../platform/src/rom/riskEngine.js');
const SmartOrderRouter = require('../platform/src/sor/router.js');
const PIQEngine = require('../platform/src/piq/piqEngine.js');

// Helper: Calculate statistical percentiles (p50, p90, p99, p99.9) in microseconds
function calculateStats(latenciesUs) {
    if (latenciesUs.length === 0) return { min: 0, mean: 0, p50: 0, p90: 0, p99: 0, p999: 0, max: 0 };
    
    latenciesUs.sort((a, b) => a - b);
    const sum = latenciesUs.reduce((acc, val) => acc + val, 0);
    const mean = sum / latenciesUs.length;
    
    const p = (pct) => {
        const index = Math.min(latenciesUs.length - 1, Math.floor((pct / 100) * latenciesUs.length));
        return latenciesUs[index];
    };

    return {
        min: latenciesUs[0],
        mean: mean,
        p50: p(50),
        p90: p(90),
        p99: p(99),
        p999: p(99.9),
        max: latenciesUs[latenciesUs.length - 1]
    };
}

function formatUs(us) {
    if (us < 1) return `${(us * 1000).toFixed(1)} ns`;
    if (us < 1000) return `${us.toFixed(2)} µs`;
    return `${(us / 1000).toFixed(2)} ms`;
}

function printHeader(title) {
    console.log(`\n================================================================================`);
    console.log(`⚡ ${title}`);
    console.log(`================================================================================`);
}

async function runBenchmarkSuite() {
    printHeader("OPEN INTEREST — COMPREHENSIVE SYSTEM EXTREME LIMITS & BENCHMARK");
    console.log(`Date & Time:       ${new Date().toISOString()}`);
    console.log(`Node.js Version:   ${process.version}`);
    console.log(`Platform / OS:     ${process.platform} (${process.arch})`);
    console.log(`V8 Heap Limit:     ${(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024).toFixed(0)} MB`);

    const summaryResults = [];

    // =========================================================================
    // BENCHMARK 1: In-Memory Matching Engine (Double-Auction FIFO)
    // =========================================================================
    printHeader("BENCHMARK 1: In-Memory Matching Engine (Price-Time Priority)");
    {
        const engineManager = new MatchingEngineManager();
        const symbol = 'GC Dec27';
        engineManager.registerInstrument(symbol, 0.10);
        const book = engineManager.getBook(symbol);

        const TOTAL_ORDERS = 100000;
        const RESTING_COUNT = 50000;
        const CROSSING_COUNT = 35000;
        const CANCEL_COUNT = 15000;

        console.log(`Configuration:     ${TOTAL_ORDERS.toLocaleString()} total operations on ${symbol}`);
        console.log(`  ├─ Resting Orders:  ${RESTING_COUNT.toLocaleString()} (Passive Liquidity generation)`);
        console.log(`  ├─ Crossing Fills:  ${CROSSING_COUNT.toLocaleString()} (Aggressive Market/Limit sweeps)`);
        console.log(`  └─ Cancellations:   ${CANCEL_COUNT.toLocaleString()} (O(1) fast order removal)`);

        const latencies = [];
        const restingOrderIds = [];

        const startMem = process.memoryUsage().heapUsed;
        const startTime = performance.now();

        // 1.A: Place Resting Limit Orders (Bids & Asks around base price 2650.0)
        for (let i = 0; i < RESTING_COUNT; i++) {
            const isBuy = i % 2 === 0;
            const tickOffset = (i % 50) + 1;
            const price = isBuy ? Number((2650.0 - (tickOffset * 0.10)).toFixed(2)) : Number((2650.0 + (tickOffset * 0.10)).toFixed(2));
            const orderId = `rest-${i}`;
            restingOrderIds.push(orderId);

            const t0 = performance.now();
            book.processOrder({
                id: orderId,
                traderId: `trader_${i % 10}`,
                instrument: symbol,
                side: isBuy ? 'BUY' : 'SELL',
                type: 'LIMIT',
                price,
                qty: (i % 5) + 1,
                tif: 'DAY'
            });
            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000); // convert to microseconds
        }

        // 1.B: Place Crossing Aggressive Orders (Triggering Matches & Fills)
        for (let i = 0; i < CROSSING_COUNT; i++) {
            const isBuy = i % 2 === 0;
            // Cross opposite side of the book
            const price = isBuy ? 2660.0 : 2640.0;
            const orderId = `cross-${i}`;

            const t0 = performance.now();
            book.processOrder({
                id: orderId,
                traderId: `trader_aggr_${i % 10}`,
                instrument: symbol,
                side: isBuy ? 'BUY' : 'SELL',
                type: 'LIMIT',
                price,
                qty: 2,
                tif: 'IOC'
            });
            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000);
        }

        // 1.C: Cancellations (O(1) Map Hash Lookup)
        const cancelTargetIds = restingOrderIds.slice(0, CANCEL_COUNT);
        for (let i = 0; i < cancelTargetIds.length; i++) {
            const t0 = performance.now();
            book.cancelOrder(cancelTargetIds[i]);
            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000);
        }

        const endTime = performance.now();
        const endMem = process.memoryUsage().heapUsed;
        const totalDurationSec = (endTime - startTime) / 1000;
        const ops = TOTAL_ORDERS / totalDurationSec;
        const stats = calculateStats(latencies);

        console.log(`\nResults:`);
        console.log(`  ⚡ Measured Throughput:    ${Math.round(ops).toLocaleString()} ORDERS / SEC`);
        console.log(`  ⏱️  Mean Latency:          ${formatUs(stats.mean)}`);
        console.log(`  ⏱️  p50 (Median):          ${formatUs(stats.p50)}`);
        console.log(`  ⏱️  p90:                   ${formatUs(stats.p90)}`);
        console.log(`  ⏱️  p99:                   ${formatUs(stats.p99)}`);
        console.log(`  ⏱️  p99.9:                 ${formatUs(stats.p999)}`);
        console.log(`  💾 Memory Delta:          +${((endMem - startMem) / 1024 / 1024).toFixed(2)} MB`);

        summaryResults.push({
            tier: 'Matching Engine (Double-Auction)',
            ops: Math.round(ops),
            mean: formatUs(stats.mean),
            p50: formatUs(stats.p50),
            p99: formatUs(stats.p99)
        });
    }

    // =========================================================================
    // BENCHMARK 2: Pre-Trade Risk Engine (ROM)
    // =========================================================================
    printHeader("BENCHMARK 2: Pre-Trade Risk Engine (ROM Checks & Margin Reservation)");
    {
        const rom = new RiskEngine();
        const symbol = 'CL Dec27';
        const traderId = 'trader1';
        rom.setTraderLimits(traderId, symbol, {
            maxOrderQty: 100,
            maxPosition: 500,
            maxNotional: 25000000,
            tradeAllowed: true
        });

        const TOTAL_CHECKS = 100000;
        const latencies = [];

        console.log(`Configuration:     ${TOTAL_CHECKS.toLocaleString()} pre-trade margin evaluations on ${symbol}`);

        const startTime = performance.now();
        for (let i = 0; i < TOTAL_CHECKS; i++) {
            const isBuy = i % 2 === 0;
            const order = {
                id: `rom-${i}`,
                traderId,
                instrument: symbol,
                side: isBuy ? 'BUY' : 'SELL',
                qty: (i % 10) + 1,
                price: 78.50
            };

            const t0 = performance.now();
            const check = rom.checkOrder(order, 78.50);
            if (check.allowed) {
                rom.reserveWorkingMargin(order);
                // Simulate periodic fill to release margin
                if (i % 5 === 0) {
                    rom.onTrade({
                        buyerId: traderId,
                        sellerId: 'MARKET_MAKER',
                        instrument: symbol,
                        price: 78.50,
                        qty: 1
                    });
                }
            }
            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000);
        }
        const endTime = performance.now();
        const totalDurationSec = (endTime - startTime) / 1000;
        const ops = TOTAL_CHECKS / totalDurationSec;
        const stats = calculateStats(latencies);

        console.log(`\nResults:`);
        console.log(`  ⚡ Measured Throughput:    ${Math.round(ops).toLocaleString()} CHECKS / SEC`);
        console.log(`  ⏱️  Mean Latency:          ${formatUs(stats.mean)}`);
        console.log(`  ⏱️  p50 (Median):          ${formatUs(stats.p50)}`);
        console.log(`  ⏱️  p90:                   ${formatUs(stats.p90)}`);
        console.log(`  ⏱️  p99:                   ${formatUs(stats.p99)}`);
        console.log(`  ⏱️  p99.9:                 ${formatUs(stats.p999)}`);

        summaryResults.push({
            tier: 'Pre-Trade Risk Engine (ROM)',
            ops: Math.round(ops),
            mean: formatUs(stats.mean),
            p50: formatUs(stats.p50),
            p99: formatUs(stats.p99)
        });
    }

    // =========================================================================
    // BENCHMARK 3: Smart Order Router (SOR)
    // =========================================================================
    printHeader("BENCHMARK 3: Smart Order Router (SOR Venue Topic Resolution)");
    {
        const sor = new SmartOrderRouter(null);
        const instruments = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];
        const TOTAL_ROUTES = 100000;
        const latencies = [];

        console.log(`Configuration:     ${TOTAL_ROUTES.toLocaleString()} order routing resolutions across 5 exchanges`);

        const startTime = performance.now();
        for (let i = 0; i < TOTAL_ROUTES; i++) {
            const inst = instruments[i % instruments.length];
            const order = {
                id: `sor-${i}`,
                traderId: 'trader1',
                instrument: inst,
                side: 'BUY',
                type: 'LIMIT',
                price: 100.0,
                qty: 5,
                tif: 'DAY'
            };

            const t0 = performance.now();
            sor.routeOrder(order);
            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000);
        }
        const endTime = performance.now();
        const totalDurationSec = (endTime - startTime) / 1000;
        const ops = TOTAL_ROUTES / totalDurationSec;
        const stats = calculateStats(latencies);

        console.log(`\nResults:`);
        console.log(`  ⚡ Measured Throughput:    ${Math.round(ops).toLocaleString()} ROUTES / SEC`);
        console.log(`  ⏱️  Mean Latency:          ${formatUs(stats.mean)}`);
        console.log(`  ⏱️  p50 (Median):          ${formatUs(stats.p50)}`);
        console.log(`  ⏱️  p90:                   ${formatUs(stats.p90)}`);
        console.log(`  ⏱️  p99:                   ${formatUs(stats.p99)}`);

        summaryResults.push({
            tier: 'Smart Order Router (SOR)',
            ops: Math.round(ops),
            mean: formatUs(stats.mean),
            p50: formatUs(stats.p50),
            p99: formatUs(stats.p99)
        });
    }

    // =========================================================================
    // BENCHMARK 4: Position-In-Queue Engine (PIQ)
    // =========================================================================
    printHeader("BENCHMARK 4: Position-in-Queue (PIQ Telemetry & Probability Math)");
    {
        const piq = new PIQEngine(null);
        const symbol = 'SR3 Dec27';
        const TOTAL_PIQ = 50000;
        const latencies = [];

        console.log(`Configuration:     ${TOTAL_PIQ.toLocaleString()} queue registrations & dynamic ahead updates`);

        const trackedIds = [];
        const startTime = performance.now();
        for (let i = 0; i < TOTAL_PIQ; i++) {
            const price = Number((96.000 + ((i % 25) * 0.005)).toFixed(3));
            const order = {
                id: `piq-${i}`,
                traderId: `trader_${i % 5}`,
                instrument: symbol,
                side: 'BUY',
                price: price,
                qty: (i % 5) + 1
            };

            const t0 = performance.now();
            piq.trackOrder(order, 10);
            trackedIds.push(order.id);

            // Periodically process trades ahead in queue
            if (i % 2 === 0) {
                piq.onTrade({
                    instrument: symbol,
                    price: price,
                    qty: 1
                });
            }
            if (i > 50 && i % 3 === 0) {
                piq.untrackOrder(trackedIds[i - 50]);
            }
            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000);
        }
        const endTime = performance.now();
        const totalDurationSec = (endTime - startTime) / 1000;
        const ops = TOTAL_PIQ / totalDurationSec;
        const stats = calculateStats(latencies);

        console.log(`\nResults:`);
        console.log(`  ⚡ Measured Throughput:    ${Math.round(ops).toLocaleString()} PIQ UPDATES / SEC`);
        console.log(`  ⏱️  Mean Latency:          ${formatUs(stats.mean)}`);
        console.log(`  ⏱️  p50 (Median):          ${formatUs(stats.p50)}`);
        console.log(`  ⏱️  p90:                   ${formatUs(stats.p90)}`);
        console.log(`  ⏱️  p99:                   ${formatUs(stats.p99)}`);

        summaryResults.push({
            tier: 'Queue Estimator (PIQ)',
            ops: Math.round(ops),
            mean: formatUs(stats.mean),
            p50: formatUs(stats.p50),
            p99: formatUs(stats.p99)
        });
    }

    // =========================================================================
    // BENCHMARK 5: Full Integrated Pipeline (End-to-End Microservices Loop)
    // =========================================================================
    printHeader("BENCHMARK 5: Full Integrated Execution Pipeline (End-to-End Loop)");
    {
        const engineManager = new MatchingEngineManager();
        const symbol = 'GC Dec27';
        engineManager.registerInstrument(symbol, 0.10);
        const book = engineManager.getBook(symbol);

        const rom = new RiskEngine();
        rom.setTraderLimits('trader1', symbol, { maxOrderQty: 100, maxPosition: 1000, maxNotional: 50000000, tradeAllowed: true });
        rom.setTraderLimits('trader2', symbol, { maxOrderQty: 100, maxPosition: 1000, maxNotional: 50000000, tradeAllowed: true });

        const sor = new SmartOrderRouter(null);
        const piq = new PIQEngine(null);

        // Pre-seed book with resting liquidity on both sides
        for (let i = 1; i <= 20; i++) {
            book.processOrder({
                id: `seed-bid-${i}`,
                traderId: 'seed_maker',
                instrument: symbol,
                side: 'BUY',
                type: 'LIMIT',
                price: Number((2650.0 - (i * 0.10)).toFixed(2)),
                qty: 20,
                tif: 'GTC'
            });
            book.processOrder({
                id: `seed-ask-${i}`,
                traderId: 'seed_maker',
                instrument: symbol,
                side: 'SELL',
                type: 'LIMIT',
                price: Number((2650.0 + (i * 0.10)).toFixed(2)),
                qty: 20,
                tif: 'GTC'
            });
        }

        const TOTAL_PIPELINE_ORDERS = 50000;
        const latencies = [];

        console.log(`Configuration:     ${TOTAL_PIPELINE_ORDERS.toLocaleString()} complete end-to-end trading cycles`);
        console.log(`Execution Chain:   Trader Ingress ──► ROM Pre-Trade ──► SOR Route ──► Matching Engine ──► PIQ & Risk PnL`);

        const startTime = performance.now();
        for (let i = 0; i < TOTAL_PIPELINE_ORDERS; i++) {
            const isBuy = i % 2 === 0;
            const traderId = isBuy ? 'trader1' : 'trader2';
            const price = isBuy ? 2649.90 : 2650.10;
            const qty = 1;

            const order = {
                id: `e2e-${i}`,
                traderId,
                instrument: symbol,
                side: isBuy ? 'BUY' : 'SELL',
                type: 'LIMIT',
                price,
                qty,
                tif: 'DAY'
            };

            const t0 = performance.now();

            // 1. ROM Pre-Trade Check
            const riskResult = rom.checkOrder(order, price);
            if (riskResult.allowed) {
                // 2. ROM Margin Reservation
                rom.reserveWorkingMargin(order);

                // 3. SOR Venue Resolution
                const routed = sor.routeOrder(order);

                // 4. Matching Engine Execution
                const matchResult = book.processOrder(routed.payload);

                // 5. PIQ Track
                piq.trackOrder(order, 10);

                // 6. Post-Trade Settlement
                if (matchResult.trades && matchResult.trades.length > 0) {
                    for (const trade of matchResult.trades) {
                        rom.onTrade(trade);
                        piq.onTrade(trade);
                    }
                }
            }

            const t1 = performance.now();
            latencies.push((t1 - t0) * 1000);
        }
        const endTime = performance.now();
        const totalDurationSec = (endTime - startTime) / 1000;
        const ops = TOTAL_PIPELINE_ORDERS / totalDurationSec;
        const stats = calculateStats(latencies);

        console.log(`\nResults:`);
        console.log(`  ⚡ Measured Pipeline Speed:  ${Math.round(ops).toLocaleString()} FULL TRADING CYCLES / SEC`);
        console.log(`  ⏱️  Mean E2E Latency:       ${formatUs(stats.mean)}`);
        console.log(`  ⏱️  p50 (Median):           ${formatUs(stats.p50)}`);
        console.log(`  ⏱️  p90:                    ${formatUs(stats.p90)}`);
        console.log(`  ⏱️  p99:                    ${formatUs(stats.p99)}`);
        console.log(`  ⏱️  p99.9:                  ${formatUs(stats.p999)}`);

        summaryResults.push({
            tier: 'Full End-to-End Microservices Loop',
            ops: Math.round(ops),
            mean: formatUs(stats.mean),
            p50: formatUs(stats.p50),
            p99: formatUs(stats.p99)
        });
    }

    // =========================================================================
    // FINAL SUMMARY SCORECARD
    // =========================================================================
    printHeader("🏆 OPEN INTEREST BENCHMARK SCORECARD SUMMARY");
    console.log(`┌──────────────────────────────────────────────┬──────────────────┬──────────────┬──────────────┬──────────────┐`);
    console.log(`│ Subsystem / Architectural Tier               │ Throughput (OPS) │ Latency Mean │ p50 (Median) │ p99 (Tail)   │`);
    console.log(`├──────────────────────────────────────────────┼──────────────────┼──────────────┼──────────────┼──────────────┤`);
    for (const r of summaryResults) {
        const tier = r.tier.padEnd(44, ' ');
        const ops = `${r.ops.toLocaleString()} /s`.padStart(16, ' ');
        const mean = r.mean.padStart(12, ' ');
        const p50 = r.p50.padStart(12, ' ');
        const p99 = r.p99.padStart(12, ' ');
        console.log(`│ ${tier} │ ${ops} │ ${mean} │ ${p50} │ ${p99} │`);
    }
    console.log(`└──────────────────────────────────────────────┴──────────────────┴──────────────┴──────────────┴──────────────┘\n`);
}

runBenchmarkSuite().catch(err => {
    console.error('[Benchmark Suite Error]:', err);
    process.exit(1);
});
