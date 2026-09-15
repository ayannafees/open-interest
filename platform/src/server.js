require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Kafka } = require('kafkajs');
const RiskEngine = require('./rom/riskEngine.js');
const SmartOrderRouter = require('./sor/router.js');
const PIQEngine = require('./piq/piqEngine.js');
const db = require('./db.js');

const PORT = process.env.PORT_PLATFORM || 4002;
const KAFKA_BROKER = process.env.KAFKA_BROKER_EXTERNAL || process.env.KAFKA_BROKER || 'localhost:29092';

async function startPlatformServer() {
    const app = express();
    app.use(cors());
    app.use(express.json());

    // 1. Initialize Kafka Client
    const kafka = new Kafka({
        clientId: 'open-interest-platform',
        brokers: [KAFKA_BROKER],
        retry: { retries: 10, initialRetryTime: 300 }
    });

    const producer = kafka.producer();
    await producer.connect();
    console.log(`[Platform] Kafka Producer connected to ${KAFKA_BROKER}`);

    // 2. Initialize Core Platform Engines
    const riskEngine = new RiskEngine();
    const sor = new SmartOrderRouter(producer);
    const piqEngine = new PIQEngine(producer);

    // Hydrate Risk Limits & Positions from PostgreSQL / TimescaleDB
    try {
        const dbLimits = await db.loadAllLimits();
        if (dbLimits && dbLimits.length > 0) {
            riskEngine.loadLimitsFromDb(dbLimits);
            console.log(`[Platform ROM] Hydrated ${dbLimits.length} risk limits from database`);
        }
        const dbPositions = await db.loadAllPositions();
        if (dbPositions && dbPositions.length > 0) {
            riskEngine.loadPositionsFromDb(dbPositions);
            console.log(`[Platform ROM] Hydrated ${dbPositions.length} positions from database`);
        }
    } catch (err) {
        console.warn('[Platform ROM] DB hydration notice (using defaults):', err.message);
    }

    // Latest market prices cache for dynamic distance calculations
    const latestPrices = new Map();

    // 3. Core Order Ingestion & Routing Function
    async function processIncomingOrder(orderPayload) {
        // A. Handle CANCEL Action
        if (orderPayload.action === 'CANCEL') {
            const routed = sor.routeCancel(orderPayload);
            await sor.dispatch(routed);
            riskEngine.onOrderEvent({ orderId: orderPayload.orderId, status: 'CANCELLED' });
            piqEngine.onOrderEvent({ orderId: orderPayload.orderId, status: 'CANCELLED' });
            return { status: 'CANCEL_DISPATCHED', orderId: orderPayload.orderId };
        }

        const marketPrice = latestPrices.get(orderPayload.instrument)?.last || null;

        // B. Pre-Trade Risk Check (ROM)
        const riskCheck = riskEngine.checkOrder(orderPayload, marketPrice);
        if (!riskCheck.allowed) {
            const rejectEvent = {
                orderId: orderPayload.id,
                traderId: orderPayload.traderId,
                instrument: orderPayload.instrument,
                status: 'REJECTED',
                reason: riskCheck.reason,
                details: riskCheck.details,
                timestamp: new Date().toISOString()
            };

            await producer.send({
                topic: 'order_events',
                messages: [{
                    key: orderPayload.id,
                    value: JSON.stringify(rejectEvent)
                }]
            });

            return { status: 'REJECTED', reason: riskCheck.reason, details: riskCheck.details };
        }

        // C. Route Order via SOR
        const routed = sor.routeOrder(orderPayload);
        const dispatchResult = await sor.dispatch(routed);

        if (routed.isDeadLetter || dispatchResult.status === 'DEAD_LETTERED') {
            console.warn(`[Platform] Order ${orderPayload.id} dead-lettered due to unknown venue: ${orderPayload.instrument}`);
            return {
                status: 'DEAD_LETTERED',
                topic: 'dead_letter',
                reason: 'UNKNOWN_VENUE',
                orderId: orderPayload.id
            };
        }

        // D. Reserve Working Order Margin (ROM)
        riskEngine.reserveWorkingMargin(orderPayload);

        // E. Track Order in PIQ Tracker & Broadcast Initial Queue Telemetry
        if (orderPayload.type === 'LIMIT') {
            const priceData = latestPrices.get(orderPayload.instrument) || {};
            const bestBid = priceData.bestBid ?? priceData.bid ?? Number(orderPayload.price);
            const bestAsk = priceData.bestAsk ?? priceData.ask ?? Number(orderPayload.price);

            let marketDepthBefore = 0;
            const orderPrice = Number(orderPayload.price);
            if (orderPayload.side === 'BUY' && Array.isArray(priceData.bids)) {
                const lvl = priceData.bids.find(b => Math.abs(Number(b.price) - orderPrice) < 0.0001);
                if (lvl) marketDepthBefore = Number(lvl.size || lvl.qty || lvl.volume || 0);
            } else if (orderPayload.side === 'SELL' && Array.isArray(priceData.asks)) {
                const lvl = priceData.asks.find(a => Math.abs(Number(a.price) - orderPrice) < 0.0001);
                if (lvl) marketDepthBefore = Number(lvl.size || lvl.qty || lvl.volume || 0);
            }

            piqEngine.trackOrder(orderPayload, marketDepthBefore);
            await piqEngine.broadcastUpdate(orderPayload.id, bestBid, bestAsk);
        }

        return { status: 'ROUTED', topic: routed.topic, orderId: orderPayload.id };
    }

    // 4. Start Kafka Consumer for Orders, Trades, Order Events, and Prices
    const consumer = kafka.consumer({
        groupId: 'platform-services-group',
        sessionTimeout: 10000,
        heartbeatInterval: 1000
    });
    await consumer.connect();

    await consumer.subscribe({ topic: 'orders', fromBeginning: false });
    await consumer.subscribe({ topic: 'trades', fromBeginning: true });
    await consumer.subscribe({ topic: 'order_events', fromBeginning: true });
    await consumer.subscribe({ topic: 'prices', fromBeginning: false });

    console.log(`[Platform] Subscribed to Kafka topics: orders, trades, order_events, prices`);

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            try {
                const payload = JSON.parse(message.value.toString());

                if (topic === 'orders') {
                    await processIncomingOrder(payload);
                } else if (topic === 'trades') {
                    console.log(`[Platform Event] ⚡ TRADE MATCHED: ${payload.qty} lots @ ${payload.price} (${payload.buyerId} vs ${payload.sellerId})`);
                    riskEngine.onTrade(payload);
                    piqEngine.onTrade(payload);

                    // Persist updated positions asynchronously to PostgreSQL
                    if (payload.buyerId && payload.buyerId !== 'MARKET_MAKER') {
                        const buyerPos = riskEngine.getPosition(payload.buyerId, payload.instrument);
                        db.upsertPosition(payload.buyerId, payload.instrument, buyerPos).catch(() => {});
                    }
                    if (payload.sellerId && payload.sellerId !== 'MARKET_MAKER') {
                        const sellerPos = riskEngine.getPosition(payload.sellerId, payload.instrument);
                        db.upsertPosition(payload.sellerId, payload.instrument, sellerPos).catch(() => {});
                    }

                    // Broadcast PIQ update to all remaining active orders for this instrument
                    const priceData = latestPrices.get(payload.instrument) || {};
                    const bestBid = priceData.bestBid ?? priceData.bid ?? null;
                    const bestAsk = priceData.bestAsk ?? priceData.ask ?? null;
                    for (const [orderId, tracked] of piqEngine.trackedOrders.entries()) {
                        if (tracked.instrument === payload.instrument) {
                            await piqEngine.broadcastUpdate(orderId, bestBid, bestAsk);
                        }
                    }
                } else if (topic === 'order_events') {
                    riskEngine.onOrderEvent(payload);
                    piqEngine.onOrderEvent(payload);

                    // Broadcast updated PIQ metrics to all remaining active orders for this instrument
                    const priceData = latestPrices.get(payload.instrument) || {};
                    const bestBid = priceData.bestBid ?? priceData.bid ?? null;
                    const bestAsk = priceData.bestAsk ?? priceData.ask ?? null;
                    for (const [orderId, tracked] of piqEngine.trackedOrders.entries()) {
                        if (!payload.instrument || tracked.instrument === payload.instrument) {
                            await piqEngine.broadcastUpdate(orderId, bestBid, bestAsk);
                        }
                    }
                } else if (topic === 'prices') {
                    latestPrices.set(payload.instrument, payload);
                    const bestBid = payload.bestBid ?? payload.bid ?? null;
                    const bestAsk = payload.bestAsk ?? payload.ask ?? null;

                    // Stream updated queue metrics to all active orders on this instrument
                    for (const [orderId, tracked] of piqEngine.trackedOrders.entries()) {
                        if (tracked.instrument === payload.instrument) {
                            let totalLevelQty = null;
                            if (tracked.side === 'BUY' && Array.isArray(payload.bids)) {
                                const lvl = payload.bids.find(b => Math.abs(Number(b.price) - tracked.price) < 0.0001);
                                if (lvl) totalLevelQty = Number(lvl.size || lvl.qty || lvl.volume || 0);
                            } else if (tracked.side === 'SELL' && Array.isArray(payload.asks)) {
                                const lvl = payload.asks.find(a => Math.abs(Number(a.price) - tracked.price) < 0.0001);
                                if (lvl) totalLevelQty = Number(lvl.size || lvl.qty || lvl.volume || 0);
                            }
                            await piqEngine.broadcastUpdate(orderId, bestBid, bestAsk, totalLevelQty);
                        }
                    }
                }
            } catch (err) {
                console.error(`[Platform] Error processing message from topic ${topic}:`, err.message);
            }
        }
    });

    // 5. Express HTTP Management Endpoints (Port 4002)

    app.get('/health', (req, res) => {
        res.json({
            status: 'UP',
            service: 'open-interest-platform',
            kafkaConnected: true,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

    app.get('/risk/position/:traderId/:instrument', (req, res) => {
        const { traderId } = req.params;
        const symbol = decodeURIComponent(req.params.instrument);
        const pos = riskEngine.getPosition(traderId, symbol);
        res.json(pos);
    });

    app.get('/risk/limits/:traderId', async (req, res) => {
        const { traderId } = req.params;
        const allInstruments = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];
        const limits = allInstruments.map(inst => {
            const lim = riskEngine.getTraderLimits(traderId, inst);
            return {
                instrument: inst,
                maxOrderQty: lim.maxOrderQty,
                maxPosition: lim.maxPosition,
                maxNotional: lim.maxNotional,
                tradeAllowed: lim.tradeAllowed !== false && lim.maxOrderQty > 0 && lim.maxPosition > 0
            };
        });
        res.json({ traderId, limits });
    });

    app.post('/risk/limits', async (req, res) => {
        const { traderId, instrument, maxOrderQty, maxPosition, maxNotional, tradeAllowed } = req.body;
        if (!traderId || !instrument) {
            return res.status(400).json({ error: 'traderId and instrument are required' });
        }

        const limitsObj = {
            maxOrderQty: parseInt(maxOrderQty, 10) || 0,
            maxPosition: parseInt(maxPosition, 10) || 0,
            maxNotional: parseFloat(maxNotional) || 0,
            tradeAllowed: tradeAllowed !== false
        };

        // 1. Update in-memory RiskEngine
        riskEngine.setTraderLimits(traderId, instrument, limitsObj);

        // 2. Persist to PostgreSQL asynchronously
        db.upsertLimit(traderId, instrument, limitsObj).catch(() => {});

        res.json({
            status: 'UPDATED',
            limits: riskEngine.getTraderLimits(traderId, instrument)
        });
    });

    app.get('/piq/:orderId', (req, res) => {
        const { orderId } = req.params;
        const tracked = piqEngine.trackedOrders.get(orderId);
        if (!tracked) {
            return res.status(404).json({ error: `Order ${orderId} not found in active queue` });
        }

        const priceData = latestPrices.get(tracked.instrument) || { bid: tracked.price, ask: tracked.price };
        const bestBid = priceData.bestBid ?? priceData.bid ?? tracked.price;
        const bestAsk = priceData.bestAsk ?? priceData.ask ?? tracked.price;
        const metrics = piqEngine.calculateMetrics(orderId, bestBid, bestAsk);
        res.json(metrics);
    });

    app.post('/order', async (req, res) => {
        try {
            const { id, orderId, traderId, instrument, side, type, price, qty, tif } = req.body;
            const finalId = id || orderId;

            if (!finalId || !traderId || !instrument || !side || !qty) {
                return res.status(400).json({ error: 'Missing required order fields' });
            }

            const result = await processIncomingOrder({
                id: finalId,
                traderId,
                instrument,
                side,
                type: type || 'LIMIT',
                price: Number(price),
                qty: parseInt(qty, 10),
                tif: tif || 'DAY'
            });

            res.json(result);
        } catch (err) {
            console.error('[Platform] POST /order error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    const server = app.listen(PORT, () => {
        console.log(`[Platform] HTTP Gateway listening on port ${PORT}`);
    });

    // 6. Graceful Shutdown
    const shutdown = async () => {
        console.log('\n[Platform] Graceful shutdown initiated...');
        await consumer.disconnect().catch(() => { });
        await producer.disconnect().catch(() => { });
        server.close(() => {
            console.log('[Platform] Server shut down cleanly.');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startPlatformServer().catch(err => {
    console.error('[Platform] Fatal startup error:', err);
    process.exit(1);
});