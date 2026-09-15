require('dotenv').config();
const { Pool } = require('pg');

const CONTRACT_MULTIPLIERS = {
    'GC Dec27': 100,   // COMEX Gold (100 oz)
    'CL Dec27': 1000,  // NYMEX Crude Oil (1,000 bbl)
    'SR3 Dec27': 2500, // SOFR 3M ($2,500 point)
    'CRA Dec27': 2500, // CORRA 3M ($2,500 point)
    'ER3 Jun26': 2500  // ESTR 3M (€2,500 point)
};

/**
 * DBWriter consumes trade, price, and order events from Kafka
 * and writes them to TimescaleDB & PostgreSQL in high-speed batches.
 */
class DBWriter {
    constructor(pgConfig, kafkaConsumer = null, batchSize = 500, flushIntervalMs = 100) {
        this.batchSize = batchSize;
        this.flushIntervalMs = flushIntervalMs;
        this.kafkaConsumer = kafkaConsumer;
        this.isFlushing = false;

        // In-memory write buffers
        this.tradeBuffer = [];
        this.priceBuffer = [];
        this.orderUpdateBuffer = [];

        // pgBouncer connection pool
        this.pool = new Pool({
            host: pgConfig?.host || process.env.DB_HOST || 'localhost',
            port: pgConfig?.port || process.env.PGBOUNCER_PORT || 6432,
            database: pgConfig?.database || process.env.POSTGRES_DB || 'open_interest',
            user: pgConfig?.user || process.env.POSTGRES_USER || 'postgres',
            password: pgConfig?.password || process.env.POSTGRES_PASSWORD || 'postgres',
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        });

        this.timer = null;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
        if (this.timer.unref) {
            this.timer.unref();
        }
        console.log(`[DBWriter] Started batch persistence (Batch: ${this.batchSize}, Interval: ${this.flushIntervalMs}ms)`);
    }

    addTrade(trade) {
        this.tradeBuffer.push(trade);
        if (this.tradeBuffer.length >= this.batchSize) {
            this.flush();
        }
    }

    addPrice(price) {
        this.priceBuffer.push(price);
        if (this.priceBuffer.length >= this.batchSize) {
            this.flush();
        }
    }

    addOrderUpdate(event) {
        this.orderUpdateBuffer.push(event);
        if (this.orderUpdateBuffer.length >= this.batchSize) {
            this.flush();
        }
    }

    /**
     * Updates trader position, weighted average price, and realized P&L inside the transaction
     */
    async _updatePositionInTx(client, traderId, instrument, side, tradeQty, tradePrice) {
        if (!traderId || traderId === 'MARKET_MAKER') return;

        // Ensure trader exists in traders table (FK requirement)
        await client.query(`
            INSERT INTO traders (id, username, password_hash)
            VALUES ($1, $1, 'auto_generated')
            ON CONFLICT (id) DO NOTHING;
        `, [traderId]);

        const multiplier = CONTRACT_MULTIPLIERS[instrument] || 1;

        // Lock existing position row for ACID calculation
        const existing = await client.query(`
            SELECT buy_qty, sell_qty, net_pos, avg_px, realized_pl 
            FROM positions 
            WHERE trader_id = $1 AND instrument = $2
            FOR UPDATE;
        `, [traderId, instrument]);

        let buyQty = 0;
        let sellQty = 0;
        let netPos = 0;
        let avgPx = 0;
        let realizedPl = 0;

        if (existing.rows.length > 0) {
            const row = existing.rows[0];
            buyQty = parseInt(row.buy_qty, 10) || 0;
            sellQty = parseInt(row.sell_qty, 10) || 0;
            netPos = parseInt(row.net_pos, 10) || 0;
            avgPx = parseFloat(row.avg_px) || 0;
            realizedPl = parseFloat(row.realized_pl) || 0;
        }

        if (side === 'BUY') {
            buyQty += tradeQty;
            if (netPos >= 0) {
                // Opening / adding to Long position
                const newNet = netPos + tradeQty;
                avgPx = (netPos * avgPx + tradeQty * tradePrice) / newNet;
                netPos = newNet;
            } else {
                // Closing / flipping Short position
                const currentShort = Math.abs(netPos);
                const closingQty = Math.min(currentShort, tradeQty);
                realizedPl += (avgPx - tradePrice) * closingQty * multiplier;
                netPos += tradeQty;
                if (netPos === 0) {
                    avgPx = 0;
                } else if (netPos > 0) {
                    avgPx = tradePrice; // Flipped to Long
                }
            }
        } else if (side === 'SELL') {
            sellQty += tradeQty;
            if (netPos <= 0) {
                // Opening / adding to Short position
                const currentShort = Math.abs(netPos);
                const newShort = currentShort + tradeQty;
                avgPx = (currentShort * avgPx + tradeQty * tradePrice) / newShort;
                netPos = -newShort;
            } else {
                // Closing / flipping Long position
                const currentLong = netPos;
                const closingQty = Math.min(currentLong, tradeQty);
                realizedPl += (tradePrice - avgPx) * closingQty * multiplier;
                netPos -= tradeQty;
                if (netPos === 0) {
                    avgPx = 0;
                } else if (netPos < 0) {
                    avgPx = tradePrice; // Flipped to Short
                }
            }
        }

        // Upsert into positions table
        await client.query(`
            INSERT INTO positions (trader_id, instrument, buy_qty, sell_qty, net_pos, avg_px, realized_pl)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (trader_id, instrument)
            DO UPDATE SET 
                buy_qty = $3,
                sell_qty = $4,
                net_pos = $5,
                avg_px = $6,
                realized_pl = $7;
        `, [traderId, instrument, buyQty, sellQty, netPos, avgPx, realizedPl]);
    }

    async flush() {
        if (this.isFlushing) return;
        if (this.tradeBuffer.length === 0 && this.priceBuffer.length === 0 && this.orderUpdateBuffer.length === 0) {
            return;
        }

        this.isFlushing = true;

        const trades = this.tradeBuffer.splice(0, this.tradeBuffer.length);
        const prices = this.priceBuffer.splice(0, this.priceBuffer.length);
        const orderUpdates = this.orderUpdateBuffer.splice(0, this.orderUpdateBuffer.length);

        let client;
        try {
            client = await this.pool.connect();
            await client.query('BEGIN');

            // 1. BATCH INSERT TRADES
            if (trades.length > 0) {
                trades.sort((a, b) => a.id.localeCompare(b.id));

                const values = [];
                const placeholders = trades.map((t, idx) => {
                    const offset = idx * 10;
                    values.push(
                        t.id, t.buyerId, t.sellerId, t.instrument,
                        t.price, t.qty, t.aggressorSide,
                        t.bestBid || null, t.bestAsk || null, t.time
                    );
                    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
                }).join(', ');

                const query = `
                  INSERT INTO trades (id, buyer_id, seller_id, instrument, price, qty, aggressor_side, best_bid, best_ask, time)
                  VALUES ${placeholders}
                  ON CONFLICT (id, time) DO NOTHING;
                `;
                await client.query(query, values);

                // 1.B ATOMIC POSITION & REALIZED P&L PERSISTENCE
                for (const t of trades) {
                    const tradeQty = parseInt(t.qty, 10);
                    const tradePrice = parseFloat(t.price);

                    if (t.buyerId && t.buyerId !== 'MARKET_MAKER') {
                        await this._updatePositionInTx(client, t.buyerId, t.instrument, 'BUY', tradeQty, tradePrice);
                    }
                    if (t.sellerId && t.sellerId !== 'MARKET_MAKER') {
                        await this._updatePositionInTx(client, t.sellerId, t.instrument, 'SELL', tradeQty, tradePrice);
                    }
                }
            }

            // 2. BATCH INSERT PRICES
            if (prices.length > 0) {
                await client.query('SET LOCAL synchronous_commit = off');

                const values = [];
                const placeholders = prices.map((p, idx) => {
                    const offset = idx * 6;
                    values.push(p.instrument, p.bid, p.ask, p.last, p.volume || 0, p.time);
                    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
                }).join(', ');

                const query = `
                  INSERT INTO prices (instrument, bid, ask, last, volume, time)
                  VALUES ${placeholders}
                  ON CONFLICT (instrument, time) DO NOTHING;
                `;
                await client.query(query, values);
            }

            // 3. BATCH UPDATE ORDER STATUSES
            if (orderUpdates.length > 0) {
                for (const update of orderUpdates) {
                    if (update.orderId && update.status) {
                        await client.query(`
                            UPDATE orders 
                            SET status = $1, 
                                filled_qty = COALESCE($2, filled_qty),
                                updated_at = NOW()
                            WHERE id = $3;
                        `, [update.status, update.filledQty || null, update.orderId]);
                    }
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            if (client) {
                await client.query('ROLLBACK').catch(() => { });
            }
            console.error('[DBWriter] Batch flush transaction failed:', err.message);

            this.tradeBuffer.unshift(...trades);
            this.priceBuffer.unshift(...prices);
            this.orderUpdateBuffer.unshift(...orderUpdates);
        } finally {
            if (client) {
                client.release();
            }
            this.isFlushing = false;
        }
    }

    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.flush();
        await this.pool.end();
        console.log('[DBWriter] Stopped and closed pool');
    }
}

module.exports = DBWriter;