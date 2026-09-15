require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Kafka } = require('kafkajs');
const { MatchingEngineManager } = require('./engine.js');
const MDS = require('./mds.js');
const DBWriter = require('./db-writer.js');

const PORT = process.env.PORT_EXCHANGE || 4001;
const KAFKA_BROKER = process.env.KAFKA_BROKER_EXTERNAL || process.env.KAFKA_BROKER || 'localhost:29092';

async function startExchangeServer() {
    const app = express();
    app.use(cors());
    app.use(express.json());

    console.log(`[Exchange] Initializing matching engines...`);

    // 1. Initialize Matching Engine Manager (5 isolated OrderBooks)
    const engineManager = new MatchingEngineManager();
    engineManager.registerInstrument('GC Dec27', 0.10000);  // Gold Futures (COMEX)
    engineManager.registerInstrument('CL Dec27', 0.01000);  // Crude Oil (NYMEX)
    engineManager.registerInstrument('SR3 Dec27', 0.00500); // 3M SOFR (CME)
    engineManager.registerInstrument('CRA Dec27', 0.00500); // CORRA Rate (MX)
    engineManager.registerInstrument('ER3 Jun26', 0.00500); // Euro Short-Term Rate (ICE)

    // 2. Initialize Kafka Client
    const kafka = new Kafka({
        clientId: 'open-interest-exchange',
        brokers: [KAFKA_BROKER],
        retry: { retries: 10, initialRetryTime: 300 }
    });

    // Pre-create all platform topics on boot
    const admin = kafka.admin();
    await admin.connect();
    const allTopics = [
        'orders',
        'raw_orders_comex',
        'raw_orders_nymex',
        'raw_orders_cme',
        'raw_orders_mx',
        'raw_orders_ice',
        'trades',
        'order_events',
        'prices',
        'piq_updates',
        'risk_events',
        'dead_letter'
    ];
    const existingTopics = await admin.listTopics();
    const topicsToCreate = allTopics
        .filter(t => !existingTopics.includes(t))
        .map(topic => ({ topic, numPartitions: 1, replicationFactor: 1 }));

    if (topicsToCreate.length > 0) {
        await admin.createTopics({ topics: topicsToCreate });
        console.log(`[Exchange] Pre-created topics: ${topicsToCreate.map(t => t.topic).join(', ')}`);
    }
    await admin.disconnect();

    const producer = kafka.producer();
    await producer.connect();
    console.log(`[Exchange] Kafka Producer connected to ${KAFKA_BROKER}`);

    // 3. Initialize & Start DB Writer
    const dbWriter = new DBWriter({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.PGBOUNCER_PORT || 6432,
        database: process.env.POSTGRES_DB || 'open_interest',
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || 'postgres'
    }, null, 500, 100);
    dbWriter.start();

    // 3.B Hydrate Starting Daily Volumes from PostgreSQL
    try {
        const client = await dbWriter.pool.connect();
        const statsRes = await client.query(`
            SELECT 
                instrument, 
                COALESCE(SUM(qty), 0)::int AS volume 
            FROM trades 
            WHERE (time >= CURRENT_DATE OR time >= (NOW() AT TIME ZONE 'UTC')::date)
            GROUP BY instrument;
        `);
        for (const row of statsRes.rows) {
            const book = engineManager.getBook(row.instrument);
            if (book) {
                book.setTotalVolume(row.volume);
                console.log(`[Exchange] Hydrated starting volume for ${row.instrument}: ${row.volume} lots`);
            }
        }
        client.release();
    } catch (err) {
        console.warn('[Exchange] Failed to hydrate initial volume from DB:', err.message);
    }

    // 4. Initialize & Start MDS (Market Data Server)
    const mds = new MDS(engineManager, producer);
    mds.start(500);

    // 5. Start Kafka Consumer for the 5 Venue Order Topics
    const consumer = kafka.consumer({ groupId: 'exchange-matching-engine-group' });
    await consumer.connect();

    const venueTopics = [
        'raw_orders_comex',
        'raw_orders_nymex',
        'raw_orders_cme',
        'raw_orders_mx',
        'raw_orders_ice'
    ];

    for (const topic of venueTopics) {
        await consumer.subscribe({ topic, fromBeginning: false });
    }

    console.log(`[Exchange] Subscribed to venue order topics: ${venueTopics.join(', ')}`);

    // 6. The Core Event-Driven Matching Loop
    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            try {
                const payload = JSON.parse(message.value.toString());

                if (payload.action === 'CANCEL') {
                    const cxlResult = engineManager.cancelOrder(payload.instrument, payload.orderId);
                    if (cxlResult.event) {
                        await producer.send({
                            topic: 'order_events',
                            messages: [{
                                key: payload.orderId,
                                value: JSON.stringify(cxlResult.event)
                            }]
                        });
                        dbWriter.addOrderUpdate(cxlResult.event);
                    }
                } else {
                    const { trades, events } = engineManager.processOrder(payload);

                    if (trades.length > 0) {
                        const tradeMessages = trades.map(t => ({
                            key: t.buyerId,
                            value: JSON.stringify(t)
                        }));

                        await producer.send({
                            topic: 'trades',
                            messages: tradeMessages
                        });

                        for (const t of trades) {
                            dbWriter.addTrade(t);
                        }
                    }

                    if (events.length > 0) {
                        const eventMessages = events.map(e => ({
                            key: e.orderId,
                            value: JSON.stringify(e)
                        }));

                        await producer.send({
                            topic: 'order_events',
                            messages: eventMessages
                        });

                        for (const e of events) {
                            dbWriter.addOrderUpdate(e);
                        }
                    }
                }
            } catch (err) {
                console.error(`[Exchange] Error processing message from topic ${topic}:`, err.message);
            }
        }
    });

    // 7. Express HTTP Endpoints (Port 4001)

    app.get('/health', (req, res) => {
        res.json({
            status: 'UP',
            service: 'open-interest-exchange',
            kafkaConnected: true,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

    app.post('/order', async (req, res) => {
        try {
            const { orderId, traderId, instrument, side, type, price, qty, tif } = req.body;

            if (!orderId || !traderId || !instrument || !side || !type || !qty) {
                return res.status(400).json({ error: 'Missing required order fields' });
            }

            const venueMap = {
                'GC Dec27': 'raw_orders_comex',
                'CL Dec27': 'raw_orders_nymex',
                'SR3 Dec27': 'raw_orders_cme',
                'CRA Dec27': 'raw_orders_mx',
                'ER3 Jun26': 'raw_orders_ice'
            };

            const topic = venueMap[instrument];
            if (!topic) {
                return res.status(400).json({ error: `Unknown instrument: ${instrument}` });
            }

            await producer.send({
                topic,
                messages: [{
                    key: instrument,
                    value: JSON.stringify({
                        id: orderId,
                        traderId,
                        instrument,
                        side,
                        type,
                        price: Number(price),
                        qty: parseInt(qty, 10),
                        tif: tif || 'DAY'
                    })
                }]
            });

            res.json({ orderId, status: 'RECEIVED' });
        } catch (err) {
            console.error('[Exchange] POST /order error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/order/:orderId', async (req, res) => {
        try {
            const { orderId } = req.params;
            const { traderId, instrument } = req.body;

            if (!instrument) {
                return res.status(400).json({ error: 'Instrument is required in request body' });
            }

            const venueMap = {
                'GC Dec27': 'raw_orders_comex',
                'CL Dec27': 'raw_orders_nymex',
                'SR3 Dec27': 'raw_orders_cme',
                'CRA Dec27': 'raw_orders_mx',
                'ER3 Jun26': 'raw_orders_ice'
            };

            const topic = venueMap[instrument];
            if (!topic) {
                return res.status(400).json({ error: `Unknown instrument: ${instrument}` });
            }

            await producer.send({
                topic,
                messages: [{
                    key: instrument,
                    value: JSON.stringify({
                        action: 'CANCEL',
                        orderId,
                        traderId,
                        instrument
                    })
                }]
            });

            res.json({ orderId, status: 'CANCEL_REQUESTED' });
        } catch (err) {
            console.error('[Exchange] DELETE /order error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/book/:instrument', (req, res) => {
        const symbol = decodeURIComponent(req.params.instrument);
        const book = engineManager.getBook(symbol);
        if (!book) {
            return res.status(404).json({ error: `Instrument ${symbol} not found` });
        }
        res.json(book.getDepth(20));
    });

    app.get('/admin/mds/mode', (req, res) => {
        res.json({
            mode: mds.mode,
            intervalMs: 500,
            isRunning: mds.isRunning
        });
    });

    app.post('/admin/mds/mode', (req, res) => {
        const { mode } = req.body;
        if (mode !== 'RANDOM_WALK' && mode !== 'USER_DRIVEN') {
            return res.status(400).json({
                error: "Invalid mode. Must be either 'RANDOM_WALK' or 'USER_DRIVEN'"
            });
        }

        mds.setMode(mode);
        res.json({
            status: 'SUCCESS',
            activeMode: mds.mode,
            timestamp: new Date().toISOString()
        });
    });

    const server = app.listen(PORT, () => {
        console.log(`[Exchange] HTTP Gateway listening on port ${PORT}`);
    });

    // 8. Graceful Shutdown
    const shutdown = async () => {
        console.log('\n[Exchange] Graceful shutdown initiated...');
        mds.stop();
        await consumer.disconnect().catch(() => { });
        await producer.disconnect().catch(() => { });
        await dbWriter.stop().catch(() => { });
        server.close(() => {
            console.log('[Exchange] Server shut down cleanly.');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

startExchangeServer().catch(err => {
    console.error('[Exchange] Fatal startup error:', err);
    process.exit(1);
});