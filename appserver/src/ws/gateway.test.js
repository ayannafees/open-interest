const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const WebSocketGateway = require('./gateway.js');
const { JWT_SECRET } = require('../routes/auth.js');
const db = require('../db.js');

describe('60 FPS WebSocket Gateway & Native Trading Unit & Integration Tests (F-07)', () => {
    let server;
    let gateway;
    let mockKafkaMessages = [];
    let WS_URL;

    let tokenTrader1;
    let tokenTrader2;
    const activeSockets = [];

    before(async () => {
        // 1. Generate institutional test JWT tokens
        tokenTrader1 = jwt.sign({ id: 'trader1', username: 'trader1' }, JWT_SECRET);
        tokenTrader2 = jwt.sign({ id: 'trader2', username: 'trader2' }, JWT_SECRET);

        // 2. Mock Kafka Producer to inspect dispatched messages
        const mockProducer = {
            send: async ({ topic, messages }) => {
                mockKafkaMessages.push({ topic, messages });
                return [{ topicName: topic, partition: 0, errorCode: 0 }];
            }
        };

        // 3. Initialize HTTP Server & WebSocket Gateway
        server = http.createServer();
        gateway = new WebSocketGateway(server, { path: '/ws' }, mockProducer);

        await new Promise(resolve => {
            server.listen(0, () => {
                const port = server.address().port;
                WS_URL = `ws://localhost:${port}/ws`;
                resolve();
            });
        });
    });

    afterEach(() => {
        // Clean up all active sockets after each test
        while (activeSockets.length > 0) {
            const ws = activeSockets.pop();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.terminate();
            }
        }
    });

    after(async () => {
        await gateway.close();
        if (server.closeAllConnections) {
            server.closeAllConnections();
        }
        await new Promise(resolve => server.close(resolve));
    });

    /**
     * Helper: Creates a connected WebSocket test client with a promise-based message queue
     */
    function createTestClient(url = WS_URL) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            activeSockets.push(ws);

            const messageQueue = [];
            const waiters = [];

            ws.on('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (waiters.length > 0) {
                    const waiter = waiters.shift();
                    waiter(parsed);
                } else {
                    messageQueue.push(parsed);
                }
            });

            // Returns the next message asynchronously
            ws.nextMessage = () => {
                if (messageQueue.length > 0) {
                    return Promise.resolve(messageQueue.shift());
                }
                return new Promise(resolveMsg => {
                    waiters.push(resolveMsg);
                });
            };

            ws.on('open', () => resolve(ws));
            ws.on('error', reject);
        });
    }

    // ==========================================================================
    // 1. CONNECTION & HANDSHAKE
    // ==========================================================================
    it('1. Should connect and receive CONNECTED handshake message', async () => {
        const ws = await createTestClient();
        const msg = await ws.nextMessage();

        assert.strictEqual(msg.type, 'CONNECTED');
        assert.strictEqual(msg.authenticated, false);
        assert.strictEqual(msg.traderId, null);
    });

    // ==========================================================================
    // 2. ROOM SUBSCRIPTIONS & BROADCASTS
    // ==========================================================================
    it('2. Should subscribe to room (depth:GC Dec27) and receive broadcast payload', async () => {
        const ws = await createTestClient();
        await ws.nextMessage(); // consume CONNECTED

        ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: 'depth:GC Dec27' }));
        const subAck = await ws.nextMessage();
        assert.strictEqual(subAck.type, 'SUBSCRIBED');
        assert.strictEqual(subAck.room, 'depth:GC Dec27');

        const sentCount = gateway.broadcastToRoom('depth:GC Dec27', {
            type: 'DEPTH_UPDATE',
            instrument: 'GC Dec27',
            bestBid: 2650.00,
            bestAsk: 2650.10
        });

        assert.strictEqual(sentCount, 1);
        const data = await ws.nextMessage();
        assert.strictEqual(data.type, 'DEPTH_UPDATE');
        assert.strictEqual(data.bestBid, 2650.00);
    });

    // ==========================================================================
    // 3. UNSUBSCRIBE FROM ROOMS
    // ==========================================================================
    it('3. Should stop receiving broadcasts after UNSUBSCRIBE', async () => {
        const ws = await createTestClient();
        await ws.nextMessage();

        ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: 'ticker:CL Dec27' }));
        await ws.nextMessage();

        ws.send(JSON.stringify({ action: 'UNSUBSCRIBE', room: 'ticker:CL Dec27' }));
        const unsubAck = await ws.nextMessage();
        assert.strictEqual(unsubAck.type, 'UNSUBSCRIBED');

        const sentCount = gateway.broadcastToRoom('ticker:CL Dec27', { type: 'TICKER', price: 78.50 });
        assert.strictEqual(sentCount, 0);
    });

    // ==========================================================================
    // 4. AUTHENTICATION VIA QUERY PARAMETER
    // ==========================================================================
    it('4. Should authenticate socket via query parameter token', async () => {
        const ws = await createTestClient(`${WS_URL}?token=${tokenTrader1}`);
        const msg = await ws.nextMessage();

        assert.strictEqual(msg.type, 'CONNECTED');
        assert.strictEqual(msg.authenticated, true);
        assert.strictEqual(msg.traderId, 'trader1');
    });

    // ==========================================================================
    // 5. EXPLICIT AUTH MESSAGE ACTION
    // ==========================================================================
    it('5. Should authenticate an open unauthenticated socket via AUTH action', async () => {
        const ws = await createTestClient();
        const connMsg = await ws.nextMessage();
        assert.strictEqual(connMsg.authenticated, false);

        ws.send(JSON.stringify({ action: 'AUTH', token: tokenTrader1 }));
        const authResult = await ws.nextMessage();

        assert.strictEqual(authResult.type, 'AUTH_RESULT');
        assert.strictEqual(authResult.success, true);
        assert.strictEqual(authResult.traderId, 'trader1');
    });

    // ==========================================================================
    // 6. PRIVATE CHANNEL SECURITY PROTECTION
    // ==========================================================================
    it('6. Should BLOCK unauthorized trader from subscribing to another trader private channel', async () => {
        const ws = await createTestClient(`${WS_URL}?token=${tokenTrader2}`);
        await ws.nextMessage();

        // Trader 2 attempts to spy on Trader 1's private PIQ channel
        ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: 'piq:trader1' }));
        const err = await ws.nextMessage();

        assert.strictEqual(err.type, 'ERROR');
        assert.strictEqual(err.message, 'UNAUTHORIZED_PRIVATE_ROOM_SUBSCRIPTION');
    });

    // ==========================================================================
    // 7. DIRECT PRIVATE EXECUTION FILLS & ORDER ALERTS
    // ==========================================================================
    it('7. Should push private trade fill directly to authenticated trader via broadcastToTrader', async () => {
        const ws = await createTestClient(`${WS_URL}?token=${tokenTrader1}`);
        await ws.nextMessage();

        gateway.broadcastToTrader('trader1', {
            type: 'EXECUTION_FILL',
            side: 'BUY',
            trade: {
                id: 'tr-test-fill-1',
                instrument: 'GC Dec27',
                price: 2650.00,
                qty: 10
            }
        });

        const fillData = await ws.nextMessage();
        assert.strictEqual(fillData.type, 'EXECUTION_FILL');
        assert.strictEqual(fillData.side, 'BUY');
        assert.strictEqual(fillData.trade.id, 'tr-test-fill-1');
    });

    // ==========================================================================
    // 8. CLIENT PING / HEARTBEAT
    // ==========================================================================
    it('8. Should reply with PONG when client sends PING heartbeat', async () => {
        const ws = await createTestClient();
        await ws.nextMessage();

        ws.send(JSON.stringify({ action: 'PING' }));
        const pong = await ws.nextMessage();

        assert.strictEqual(pong.type, 'PONG');
        assert.ok(pong.timestamp);
    });

    // ==========================================================================
    // 9. NATIVE WEBSOCKET ORDER ENTRY (ZERO-HTTP TRADING)
    // ==========================================================================
    it('9. Should place order directly over WebSocket and publish to Kafka orders topic', async () => {
        mockKafkaMessages = [];
        const ws = await createTestClient(`${WS_URL}?token=${tokenTrader1}`);
        await ws.nextMessage(); // consume CONNECTED

        ws.send(JSON.stringify({
            action: 'PLACE_ORDER',
            instrument: 'GC Dec27',
            side: 'BUY',
            type: 'LIMIT',
            price: 2650.00,
            qty: 10,
            tif: 'DAY'
        }));

        const ack = await ws.nextMessage();
        assert.strictEqual(ack.type, 'ORDER_SUBMITTED');
        assert.strictEqual(ack.instrument, 'GC Dec27');
        assert.strictEqual(ack.side, 'BUY');
        assert.strictEqual(ack.qty, 10);
        assert.strictEqual(ack.price, 2650.00);
        assert.ok(ack.orderId);

        // Verify Kafka Dispatch
        assert.strictEqual(mockKafkaMessages.length, 1);
        assert.strictEqual(mockKafkaMessages[0].topic, 'orders');
        const kafkaMsg = JSON.parse(mockKafkaMessages[0].messages[0].value);
        assert.strictEqual(kafkaMsg.id, ack.orderId);
        assert.strictEqual(kafkaMsg.traderId, 'trader1');
        assert.strictEqual(kafkaMsg.instrument, 'GC Dec27');
    });

    // ==========================================================================
    // 10. NATIVE WEBSOCKET ORDER CANCELLATION
    // ==========================================================================
    it('10. Should cancel order directly over WebSocket and publish CANCEL to Kafka', async () => {
        mockKafkaMessages = [];
        const testOrderId = `ord-cancel-ws-${Date.now()}`;

        // Seed test order in database for ownership verification
        await db.query(`
      INSERT INTO orders (id, trader_id, instrument, side, type, price, qty, filled_qty, status, tif, created_at, updated_at)
      VALUES ($1, 'trader1', 'GC Dec27', 'BUY', 'LIMIT', 2650.00, 10, 0, 'SUBMITTED', 'DAY', NOW(), NOW())
    `, [testOrderId]);

        const ws = await createTestClient(`${WS_URL}?token=${tokenTrader1}`);
        await ws.nextMessage();

        ws.send(JSON.stringify({
            action: 'CANCEL_ORDER',
            orderId: testOrderId,
            instrument: 'GC Dec27'
        }));

        const cancelAck = await ws.nextMessage();
        assert.ok(cancelAck.type === 'CANCELLED' || cancelAck.type === 'CANCEL_REQUESTED');
        assert.strictEqual(cancelAck.orderId, testOrderId);
        assert.strictEqual(cancelAck.instrument, 'GC Dec27');

        // Verify Kafka Cancel Dispatch
        const cancelKafkaMsg = mockKafkaMessages.find(m => m.topic === 'orders');
        assert.ok(cancelKafkaMsg);
        const parsed = JSON.parse(cancelKafkaMsg.messages[0].value);
        assert.strictEqual(parsed.action, 'CANCEL');
        assert.strictEqual(parsed.orderId, testOrderId);
        assert.strictEqual(parsed.traderId, 'trader1');
    });
});