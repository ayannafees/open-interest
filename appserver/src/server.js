// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const http = require('http');
// const { Kafka } = require('kafkajs');

// const db = require('./db.js');
// const authRouter = require('./routes/auth.js');
// const marketRouter = require('./routes/market.js');
// const createTradingRouter = require('./routes/trading.js');
// const WebSocketGateway = require('./ws/gateway.js');

// const PORT = parseInt(process.env.PORT_APPSERVER || '4006', 10);
// const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:29092';

// /**
//  * ============================================================================
//  * startAppServer(): Bootstraps HTTP REST, WebSockets, and Kafka Fanout Bridge
//  * ============================================================================
//  */
// async function startAppServer() {
//     const app = express();
//     const server = http.createServer(app);

//     // 1. Standard Express Middleware
//     app.use(cors());
//     app.use(express.json());

//     // 2. Initialize Kafka Client (Producer + Consumer)
//     const kafka = new Kafka({
//         clientId: 'open-interest-appserver',
//         brokers: [KAFKA_BROKER],
//         retry: { retries: 5 }
//     });

//     const producer = kafka.producer();
//     await producer.connect();
//     console.log(`[AppServer] Kafka Producer connected to ${KAFKA_BROKER}`);

//     const consumer = kafka.consumer({
//         groupId: process.env.KAFKA_GROUP_ID || 'appserver-streaming-group'
//     });
//     await consumer.connect();

//     // 3. Initialize 60 FPS WebSocket Gateway (Inject Kafka Producer for Native Order Entry)
//     const gateway = new WebSocketGateway(server, { path: '/ws' }, producer);

//     // 4. Mount REST API Routes
//     app.use('/api/auth', authRouter);
//     app.use('/api/market', marketRouter);
//     app.use('/api/trading', createTradingRouter(producer));

//     // Health Check Endpoint
//     app.get('/health', (req, res) => {
//         res.json({
//             status: 'UP',
//             service: 'open-interest-appserver',
//             port: PORT,
//             uptime: process.uptime(),
//             timestamp: new Date().toISOString()
//         });
//     });

//     // 5. Subscribe to Core Kafka Streaming Topics
//     const TOPICS = ['trades', 'prices', 'piq_updates', 'order_events'];
//     for (const topic of TOPICS) {
//         await consumer.subscribe({ topic, fromBeginning: false });
//     }
//     console.log(`[AppServer] Subscribed to Kafka topics: ${TOPICS.join(', ')}`);

//     // ==========================================================================
//     // 6. THE KAFKA -> WEBSOCKET REAL-TIME STREAMING BRIDGE
//     // ==========================================================================
//     await consumer.run({
//         eachMessage: async ({ topic, partition, message }) => {
//             try {
//                 const payload = JSON.parse(message.value.toString());

//                 // A. TOPIC: 'trades' (Public Tape + Private Counterparty Fills)
//                 if (topic === 'trades') {
//                     // Broadcast to Public Tape Room
//                     gateway.broadcastToRoom(`trades:${payload.instrument}`, {
//                         type: 'TRADE_TICK',
//                         trade: payload
//                     });

//                     // Private Execution Fill to Buyer
//                     if (payload.buyerId && payload.buyerId !== 'MARKET_MAKER') {
//                         gateway.broadcastToTrader(payload.buyerId, {
//                             type: 'EXECUTION_FILL',
//                             side: 'BUY',
//                             trade: payload
//                         });
//                     }

//                     // Private Execution Fill to Seller
//                     if (payload.sellerId && payload.sellerId !== 'MARKET_MAKER') {
//                         gateway.broadcastToTrader(payload.sellerId, {
//                             type: 'EXECUTION_FILL',
//                             side: 'SELL',
//                             trade: payload
//                         });
//                     }
//                 }

//                 // B. TOPIC: 'prices' (DOM Depth Ladder & Price Tickers)
//                 else if (topic === 'prices') {
//                     // Broadcast 20-level OrderBook Depth to Ladder Watchers
//                     if (payload.bids || payload.asks) {
//                         gateway.broadcastToRoom(`depth:${payload.instrument}`, {
//                             type: 'DEPTH_UPDATE',
//                             instrument: payload.instrument,
//                             bids: payload.bids || [],
//                             asks: payload.asks || [],
//                             bestBid: payload.bestBid,
//                             bestAsk: payload.bestAsk,
//                             timestamp: payload.timestamp || payload.time
//                         });
//                     }

//                     // Broadcast Price Ticker to Header Watchers
//                     gateway.broadcastToRoom(`ticker:${payload.instrument}`, {
//                         type: 'PRICE_TICK',
//                         instrument: payload.instrument,
//                         bid: payload.bestBid || payload.bid,
//                         ask: payload.bestAsk || payload.ask,
//                         last: payload.last,
//                         volume: payload.volume,
//                         timestamp: payload.timestamp || payload.time
//                     });
//                 }

//                 // C. TOPIC: 'piq_updates' (Live Queue Rank & Fill Probability)
//                 else if (topic === 'piq_updates') {
//                     if (payload.traderId) {
//                         gateway.broadcastToRoom(`piq:${payload.traderId}`, {
//                             type: 'PIQ_UPDATE',
//                             piq: payload
//                         });
//                     }
//                 }

//                 // D. TOPIC: 'order_events' (Private Status Lifecycle Updates & Alerts)
//                 else if (topic === 'order_events') {
//                     // 1. Update Database Status to 'REJECTED', 'WORKING', 'CANCELLED', etc.
//                     if (payload.orderId && payload.status) {
//                         await db.query(`
//                             UPDATE orders
//                             SET status = $1, updated_at = NOW() 
//                             WHERE id = $2;
//                         `, [payload.status, payload.orderId]).catch(() => { });
//                     }
//                     // 2. Push Real-Time WebSocket Event to Trader
//                     if (payload.traderId) {
//                         gateway.broadcastToTrader(payload.traderId, {
//                             type: 'ORDER_EVENT',
//                             event: payload
//                         });
//                     }
//                 }
//             } catch (err) {
//                 console.error(`[AppServer Bridge Error]Failed to process ${topic}: `, err.message);
//             }
//         }
//     });

//     // 7. Start HTTP & WebSocket Server Listening
//     await new Promise((resolve) => {
//         server.listen(PORT, () => {
//             console.log(`[AppServer] HTTP & WebSocket Gateway running on http://localhost:${PORT}`);
//             resolve();
//         });
//     });

//     // Return server instances for testing and lifecycle management
//     return { app, server, gateway, producer, consumer };
// }

// // Auto-run if started directly from CLI (e.g. node src/server.js)
// if (require.main === module) {
//     startAppServer().catch((err) => {
//         console.error('[AppServer Fatal] Failed to start:', err);
//         process.exit(1);
//     });
// }

// module.exports = startAppServer;

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Kafka } = require('kafkajs');

const db = require('./db.js');
const authRouter = require('./routes/auth.js');
const adminRouter = require('./routes/admin.js');
const marketRouter = require('./routes/market.js');
const createTradingRouter = require('./routes/trading.js');
const WebSocketGateway = require('./ws/gateway.js');

const PORT = parseInt(process.env.PORT_APPSERVER || '4006', 10);
const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:29092';
const PLATFORM_URL = process.env.PLATFORM_URL || 'http://localhost:4002';

async function startAppServer() {
    // 0. Ensure database tables and initial seeds exist
    try {
        await db.initDb();
        console.log('[AppServer] Database schema initialized and verified.');
    } catch (err) {
        console.warn('[AppServer] DB Init Notice:', err.message);
    }

    const app = express();
    const server = http.createServer(app);

    app.use(cors());
    app.use(express.json());

    const kafka = new Kafka({
        clientId: 'open-interest-appserver',
        brokers: [KAFKA_BROKER],
        retry: { retries: 5 }
    });

    const producer = kafka.producer();
    await producer.connect();
    console.log(`[AppServer] Kafka Producer connected to ${KAFKA_BROKER}`);

    const consumer = kafka.consumer({
        groupId: process.env.KAFKA_GROUP_ID || 'appserver-streaming-group'
    });
    await consumer.connect();

    const gateway = new WebSocketGateway(server, { path: '/ws' }, producer);
    app.set('gateway', gateway);

    app.use('/api/auth', authRouter);
    app.use('/api/admin', adminRouter);
    app.use('/api/market', marketRouter);
    app.use('/api/trading', createTradingRouter(producer));

    app.get('/health', (req, res) => {
        res.json({
            status: 'UP',
            service: 'open-interest-appserver',
            port: PORT,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

    const TOPICS = ['trades', 'prices', 'piq_updates', 'order_events'];
    for (const topic of TOPICS) {
        await consumer.subscribe({ topic, fromBeginning: false });
    }
    console.log(`[AppServer] Subscribed to Kafka topics: ${TOPICS.join(', ')}`);

    // Helper: Push fresh position update to trader socket
    async function pushTraderPosition(traderId, instrument) {
        try {
            let pos = null;
            try {
                const platRes = await fetch(`${PLATFORM_URL}/risk/position/${traderId}/${encodeURIComponent(instrument)}`);
                if (platRes.ok) {
                    pos = await platRes.json();
                }
            } catch { }

            if (!pos) {
                const dbRes = await db.query(
                    'SELECT net_pos, avg_px, realized_pl, buy_qty, sell_qty FROM positions WHERE trader_id = $1 AND instrument = $2',
                    [traderId, instrument]
                );
                if (dbRes.rows.length > 0) {
                    const row = dbRes.rows[0];
                    pos = {
                        traderId,
                        instrument,
                        netPos: parseInt(row.net_pos, 10) || 0,
                        avgPx: parseFloat(row.avg_px) || 0,
                        realizedPnl: parseFloat(row.realized_pl) || 0,
                        buyQty: parseInt(row.buy_qty, 10) || 0,
                        sellQty: parseInt(row.sell_qty, 10) || 0
                    };
                }
            }

            if (pos) {
                gateway.broadcastToTrader(traderId, {
                    type: 'POSITION_UPDATE',
                    position: {
                        traderId,
                        instrument,
                        netPos: pos.netPos,
                        avgPx: pos.avgPx || 0,
                        realizedPl: pos.realizedPnl || pos.realizedPl || 0,
                        buyQty: pos.buyQty || 0,
                        sellQty: pos.sellQty || 0
                    }
                });
            }
        } catch (err) {
            console.warn('[AppServer] Position Push Failed:', err.message);
        }
    }

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            try {
                const payload = JSON.parse(message.value.toString());

                // A. TOPIC: 'trades'
                if (topic === 'trades') {
                    // Persist trade to Postgres trades table if not already inserted
                    db.query(`
                        INSERT INTO trades (id, buyer_id, seller_id, instrument, price, qty, aggressor_side, time)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (id, time) DO NOTHING;
                    `, [
                        payload.id || payload.tradeId || `tr_${Date.now()}_${Math.random()}`,
                        payload.buyerId || 'MARKET_MAKER',
                        payload.sellerId || 'MARKET_MAKER',
                        payload.instrument,
                        Number(payload.price),
                        parseInt(payload.qty, 10),
                        payload.aggressorSide || payload.side || 'BUY',
                        payload.time || payload.timestamp || new Date().toISOString()
                    ]).catch(() => {});

                    gateway.broadcastToRoom(`trades:${payload.instrument}`, {
                        type: 'TRADE_TICK',
                        trade: payload
                    });

                    if (payload.buyerId && payload.buyerId !== 'MARKET_MAKER') {
                        gateway.broadcastToTrader(payload.buyerId, {
                            type: 'EXECUTION_FILL',
                            side: 'BUY',
                            trade: payload
                        });
                        setTimeout(() => pushTraderPosition(payload.buyerId, payload.instrument), 50);
                    }

                    if (payload.sellerId && payload.sellerId !== 'MARKET_MAKER') {
                        gateway.broadcastToTrader(payload.sellerId, {
                            type: 'EXECUTION_FILL',
                            side: 'SELL',
                            trade: payload
                        });
                        setTimeout(() => pushTraderPosition(payload.sellerId, payload.instrument), 50);
                    }
                }

                // B. TOPIC: 'prices'
                else if (topic === 'prices') {
                    if (payload.bids || payload.asks) {
                        gateway.broadcastToRoom(`depth:${payload.instrument}`, {
                            type: 'DEPTH_UPDATE',
                            instrument: payload.instrument,
                            bids: payload.bids || [],
                            asks: payload.asks || [],
                            bestBid: payload.bestBid,
                            bestAsk: payload.bestAsk,
                            timestamp: payload.timestamp || payload.time
                        });
                    }

                    gateway.broadcastToRoom(`ticker:${payload.instrument}`, {
                        type: 'PRICE_TICK',
                        instrument: payload.instrument,
                        bid: payload.bestBid || payload.bid,
                        ask: payload.bestAsk || payload.ask,
                        last: payload.last,
                        volume: payload.volume,
                        timestamp: payload.timestamp || payload.time
                    });
                }

                // C. TOPIC: 'piq_updates'
                else if (topic === 'piq_updates') {
                    if (payload.traderId) {
                        gateway.broadcastToRoom(`piq:${payload.traderId}`, {
                            type: 'PIQ_UPDATE',
                            piq: payload
                        });
                    }
                }

                // D. TOPIC: 'order_events'
                else if (topic === 'order_events') {
                    if (payload.orderId && payload.status) {
                        await db.query(`
                            UPDATE orders
                            SET status = $1, updated_at = NOW() 
                            WHERE id = $2;
                        `, [payload.status, payload.orderId]).catch(() => { });
                    }
                    if (payload.traderId) {
                        gateway.broadcastToTrader(payload.traderId, {
                            type: 'ORDER_EVENT',
                            event: payload
                        });
                    }
                }
            } catch (err) {
                console.error(`[AppServer Bridge Error] Failed to process ${topic}:`, err.message);
            }
        }
    });

    await new Promise((resolve) => {
        server.listen(PORT, () => {
            console.log(`[AppServer] HTTP & WebSocket Gateway running on http://localhost:${PORT}`);
            resolve();
        });
    });

    return { app, server, gateway, producer, consumer };
}

if (require.main === module) {
    startAppServer().catch((err) => {
        console.error('[AppServer Fatal] Failed to start:', err);
        process.exit(1);
    });
}

module.exports = startAppServer;