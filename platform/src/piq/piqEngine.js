/**
 * Position-In-Queue (PIQ) & Fill Probability Engine
 * Enforces Invariant EX-06 (Queue Priority & Fill Probability Telemetry)
 * with O(1) Secondary Price-Level Indexing and Automatic Eviction.
 */
class PIQEngine {
    constructor(kafkaProducer = null) {
        this.producer = kafkaProducer;

        // Primary Index: orderId -> Tracked Order Object
        this.trackedOrders = new Map();

        // Secondary $O(1)$ Price Bucket Index: `${instrument}:${price}` -> Set of orderIds
        this.ordersByLevel = new Map();

        // Exact discrete tick sizes for spread distance calculations
        this.tickSizes = {
            'GC Dec27': 0.10,
            'CL Dec27': 0.01,
            'SR3 Dec27': 0.005,
            'CRA Dec27': 0.005,
            'ER3 Jun26': 0.005
        };
    }

    /**
     * Register a new working limit order into the PIQ tracker
     */
    trackOrder(order, currentLevelDepthBefore = 0) {
        const qty = parseInt(order.qty, 10);
        const price = Number(order.price);

        // Calculate queue ahead:
        // Sum remainingQty of existing active orders at the same price & side
        const levelKey = `${order.instrument}:${price}`;
        let existingTrackedQty = 0;
        const existingOrderIds = this.ordersByLevel.get(levelKey);
        if (existingOrderIds) {
            for (const existingId of existingOrderIds) {
                const existing = this.trackedOrders.get(existingId);
                if (existing && existing.side === order.side && existing.id !== order.id) {
                    existingTrackedQty += (existing.remainingQty || existing.qty || 0);
                }
            }
        }

        const initialAhead = Math.max(existingTrackedQty, parseInt(currentLevelDepthBefore, 10) || 0);

        const tracked = {
            id: order.id,
            traderId: order.traderId,
            instrument: order.instrument,
            side: order.side,
            price,
            qty,
            remainingQty: qty,
            aheadQty: initialAhead,
            createdAt: Date.now()
        };

        this.trackedOrders.set(order.id, tracked);

        // Index in Secondary Price Bucket ($O(1)$)
        if (!this.ordersByLevel.has(levelKey)) {
            this.ordersByLevel.set(levelKey, new Set());
        }
        this.ordersByLevel.get(levelKey).add(order.id);

        return tracked;
    }

    /**
     * Untrack an order when filled, cancelled, or rejected (Evicts from both indices)
     */
    untrackOrder(orderId) {
        const tracked = this.trackedOrders.get(orderId);
        if (!tracked) return;

        // 1. Remove from Secondary Price Bucket Index
        const levelKey = `${tracked.instrument}:${tracked.price}`;
        const levelSet = this.ordersByLevel.get(levelKey);
        if (levelSet) {
            levelSet.delete(orderId);
            if (levelSet.size === 0) {
                this.ordersByLevel.delete(levelKey);
            }
        }

        // 2. Remove from Primary Index
        this.trackedOrders.delete(orderId);
    }

    /**
     * Process Trade Fill: targeted price bucket update + auto-eviction of filled orders
     */
    onTrade(trade) {
        const tradePrice = Number(trade.price);
        const tradeQty = parseInt(trade.qty, 10);
        const levelKey = `${trade.instrument}:${tradePrice}`;

        const orderIdsAtLevel = this.ordersByLevel.get(levelKey);
        if (!orderIdsAtLevel || orderIdsAtLevel.size === 0) return;

        const orderIds = Array.from(orderIdsAtLevel);

        for (const orderId of orderIds) {
            const tracked = this.trackedOrders.get(orderId);
            if (!tracked) continue;

            if (trade.orderId === orderId || trade.buyerOrderId === orderId || trade.sellerOrderId === orderId) {
                tracked.remainingQty = Math.max(0, tracked.remainingQty - tradeQty);
                if (tracked.remainingQty === 0) {
                    this.untrackOrder(orderId);
                }
            } else {
                if (tracked.aheadQty > 0) {
                    tracked.aheadQty = Math.max(0, tracked.aheadQty - tradeQty);
                }
            }
        }
    }

    /**
     * Process Order Event: Evicts cancelled, rejected, or filled orders and advances queue
     */
    onOrderEvent(event) {
        const { orderId, status, remainingQty } = event;
        const tracked = this.trackedOrders.get(orderId);
        if (!tracked) return;

        if (status === 'CANCELLED' || status === 'REJECTED' || status === 'FILLED') {
            const freedQty = tracked.remainingQty || tracked.qty || 0;
            const levelKey = `${tracked.instrument}:${tracked.price}`;
            const orderIdsAtLevel = this.ordersByLevel.get(levelKey);
            if (orderIdsAtLevel && freedQty > 0) {
                for (const otherId of orderIdsAtLevel) {
                    if (otherId !== orderId) {
                        const otherTracked = this.trackedOrders.get(otherId);
                        if (otherTracked && otherTracked.side === tracked.side && otherTracked.createdAt >= tracked.createdAt) {
                            otherTracked.aheadQty = Math.max(0, otherTracked.aheadQty - freedQty);
                        }
                    }
                }
            }
            this.untrackOrder(orderId);
        } else if (status === 'PARTIALLY_FILLED' && remainingQty !== undefined) {
            const newRemaining = parseInt(remainingQty, 10);
            const filledDelta = Math.max(0, (tracked.remainingQty || tracked.qty) - newRemaining);
            tracked.remainingQty = newRemaining;
            if (tracked.remainingQty <= 0) {
                this.untrackOrder(orderId);
            }
            if (filledDelta > 0) {
                const levelKey = `${tracked.instrument}:${tracked.price}`;
                const orderIdsAtLevel = this.ordersByLevel.get(levelKey);
                if (orderIdsAtLevel) {
                    for (const otherId of orderIdsAtLevel) {
                        if (otherId !== orderId) {
                            const otherTracked = this.trackedOrders.get(otherId);
                            if (otherTracked && otherTracked.side === tracked.side && otherTracked.createdAt >= tracked.createdAt) {
                                otherTracked.aheadQty = Math.max(0, otherTracked.aheadQty - filledDelta);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Calculate PIQ and Fill Probability metrics for a tracked order
     */
    calculateMetrics(orderId, bestBid, bestAsk, totalLevelQty = null) {
        const tracked = this.trackedOrders.get(orderId);
        if (!tracked) return null;

        const tickSize = this.tickSizes[tracked.instrument] || 0.01;
        
        // Sum total active volume across all tracked orders at this price level
        const levelKey = `${tracked.instrument}:${tracked.price}`;
        let totalTrackedLevelQty = 0;
        const orderIdsAtLevel = this.ordersByLevel.get(levelKey);
        if (orderIdsAtLevel) {
            for (const id of orderIdsAtLevel) {
                const o = this.trackedOrders.get(id);
                if (o && o.side === tracked.side) {
                    totalTrackedLevelQty += (o.remainingQty || o.qty || 0);
                }
            }
        }

        const totalQty = totalLevelQty !== null
            ? Math.max(totalTrackedLevelQty, tracked.aheadQty + tracked.remainingQty, totalLevelQty)
            : Math.max(totalTrackedLevelQty, tracked.aheadQty + tracked.remainingQty);

        const behindQty = Math.max(0, totalQty - tracked.aheadQty - tracked.remainingQty);

        // 1. Tick Distance to Top of Book (Spread Delta)
        let deltaTicks = 0;
        if (tracked.side === 'BUY') {
            const referenceBest = bestBid !== null ? bestBid : tracked.price;
            deltaTicks = Math.max(0, Math.round((referenceBest - tracked.price) / tickSize));
        } else {
            const referenceBest = bestAsk !== null ? bestAsk : tracked.price;
            deltaTicks = Math.max(0, Math.round((tracked.price - referenceBest) / tickSize));
        }

        // 2. Queue Priority Ratio (Q in [0.0, 1.0])
        const queueRatio = totalQty > 0 ? (tracked.aheadQty / totalQty) : 0;

        // 3. Fill Probability Formula: rho = (1 - 0.65 * Q) * e^(-0.25 * deltaTicks)
        const baseProb = Math.max(0.05, 1.0 - (0.65 * queueRatio));
        const distanceDecay = Math.exp(-0.25 * deltaTicks);
        const fillProbability = Number((baseProb * distanceDecay).toFixed(4));

        return {
            orderId: tracked.id,
            traderId: tracked.traderId,
            instrument: tracked.instrument,
            side: tracked.side,
            price: tracked.price,
            remainingQty: tracked.remainingQty,
            piq: tracked.aheadQty,
            aheadQty: tracked.aheadQty,
            behindQty,
            totalLevelQty: totalQty,
            deltaTicks,
            queuePercentile: Number(((1.0 - queueRatio) * 100).toFixed(1)),
            fillProbability,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Broadcast PIQ telemetry to Kafka 'piq_updates' topic
     */
    async broadcastUpdate(orderId, bestBid, bestAsk, totalLevelQty = null) {
        if (!this.producer) return null;

        const metrics = this.calculateMetrics(orderId, bestBid, bestAsk, totalLevelQty);
        if (!metrics) return null;

        try {
            await this.producer.send({
                topic: 'piq_updates',
                messages: [{
                    key: metrics.traderId,
                    value: JSON.stringify(metrics)
                }]
            });
            return metrics;
        } catch (err) {
            console.error(`[PIQ] Error publishing telemetry for order ${orderId}:`, err.message);
            return null;
        }
    }
}

module.exports = PIQEngine;