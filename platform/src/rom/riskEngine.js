/**
 * ROM Pre-Trade Risk Engine
 * Enforces Invariant ROM-01 (Max Position Limit), ROM-02 (Max Notional),
 * Net Working Order Margin Reservation, and Database Hydration / Recovery.
 */
class RiskEngine {
    constructor() {
        // Key: `${traderId}:${instrument}` -> { traderId, instrument, netPos: 0, buyQty: 0, sellQty: 0, avgPx: 0, workingBuys: 0, workingSells: 0, realizedPnl: 0 }
        this.positions = new Map();

        // Key: `${traderId}:${instrument}` -> { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: true }
        this.limits = new Map();

        // Key: orderId -> { id, traderId, instrument, side, qty, price, remainingQty }
        this.activeOrders = new Map();

        // Multipliers for contract notional & P&L calculations
        this.contractMultipliers = {
            'GC Dec27': 100,   // COMEX Gold (100 oz)
            'CL Dec27': 1000,  // NYMEX Crude (1,000 bbl)
            'SR3 Dec27': 2500, // SOFR 3M ($2,500 index point)
            'CRA Dec27': 2500, // CORRA 3M ($2,500 index point)
            'ER3 Jun26': 2500  // ESTR 3M (€2,500 index point)
        };

        // Seed initial default limits for core accounts
        const allInstruments = ['GC Dec27', 'CL Dec27', 'SR3 Dec27', 'CRA Dec27', 'ER3 Jun26'];
        for (const inst of allInstruments) {
            this.setTraderLimits('trader_1', inst, { maxOrderQty: 100, maxPosition: 200, maxNotional: 10000000, tradeAllowed: true });
            this.setTraderLimits('trader_2', inst, { maxOrderQty: 100, maxPosition: 200, maxNotional: 10000000, tradeAllowed: true });
            this.setTraderLimits('trader1', inst, { maxOrderQty: 100, maxPosition: 200, maxNotional: 10000000, tradeAllowed: true });
            this.setTraderLimits('trader2', inst, { maxOrderQty: 100, maxPosition: 200, maxNotional: 10000000, tradeAllowed: true });
        }
    }

    /**
     * Bulk-hydrate risk limits from database rows (e.g. from risk_limits table)
     */
    loadLimitsFromDb(rows) {
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
            const traderId = row.trader_id || row.traderId;
            const instrument = row.instrument;
            if (!traderId || !instrument) continue;

            const maxOrderQty = parseInt(row.max_order_qty_outrights ?? row.maxOrderQty ?? 100, 10);
            const maxPosition = parseInt(row.max_long ?? row.maxPosition ?? 200, 10);
            const maxNotional = parseFloat(row.max_notional ?? row.maxNotional ?? 10000000);
            const tradeAllowed = row.trade_allowed !== false && row.tradeAllowed !== false;

            this.setTraderLimits(traderId, instrument, {
                maxOrderQty,
                maxPosition,
                maxNotional,
                tradeAllowed
            });
        }
    }

    /**
     * Bulk-hydrate open positions and realized P&L from database rows (e.g. from positions table)
     */
    loadPositionsFromDb(rows) {
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
            const traderId = row.trader_id || row.traderId;
            const instrument = row.instrument;
            if (!traderId || !instrument) continue;

            const key = `${traderId}:${instrument}`;
            const existing = this.positions.get(key);

            this.positions.set(key, {
                traderId,
                instrument,
                netPos: parseInt(row.net_pos ?? row.netPos ?? 0, 10),
                buyQty: parseInt(row.buy_qty ?? row.buyQty ?? 0, 10),
                sellQty: parseInt(row.sell_qty ?? row.sellQty ?? 0, 10),
                avgPx: parseFloat(row.avg_px ?? row.avgPx ?? 0),
                workingBuys: existing ? existing.workingBuys : 0,
                workingSells: existing ? existing.workingSells : 0,
                realizedPnl: parseFloat(row.realized_pl ?? row.realizedPnl ?? 0)
            });
        }
    }

    setTraderLimits(traderId, instrument, limits) {
        const key = `${traderId}:${instrument}`;
        this.limits.set(key, {
            maxOrderQty: limits?.maxOrderQty ?? 0,
            maxPosition: limits?.maxPosition ?? 0,
            maxNotional: limits?.maxNotional ?? 0,
            tradeAllowed: limits?.tradeAllowed !== false
        });
    }

    getTraderLimits(traderId, instrument) {
        const key = `${traderId}:${instrument}`;
        if (this.limits.has(key)) {
            return this.limits.get(key);
        }
        return { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: true };
    }

    getPosition(traderId, instrument) {
        const key = `${traderId}:${instrument}`;
        if (!this.positions.has(key)) {
            this.positions.set(key, {
                traderId,
                instrument,
                netPos: 0,
                buyQty: 0,
                sellQty: 0,
                avgPx: 0,
                workingBuys: 0,
                workingSells: 0,
                realizedPnl: 0
            });
        }
        return this.positions.get(key);
    }

    checkOrder(order, currentMarketPrice = null) {
        const { id, traderId, instrument, side, qty, price } = order;
        const limit = this.getTraderLimits(traderId, instrument);
        const pos = this.getPosition(traderId, instrument);
        const orderQty = parseInt(qty, 10);

        if (limit.maxOrderQty <= 0 || limit.maxPosition <= 0 || limit.maxNotional <= 0) {
            return {
                allowed: false,
                reason: 'NO_RISK_LIMITS_CONFIGURED',
                details: `Trading on ${instrument} is not enabled or has 0 limits for ${traderId}`
            };
        }

        if (limit.tradeAllowed === false) {
            return {
                allowed: false,
                reason: 'TRADING_SUSPENDED_BY_ADMIN',
                details: `Trading on ${instrument} is disabled for ${traderId}`
            };
        }

        if (orderQty <= 0) {
            return { allowed: false, reason: 'INVALID_ORDER_QTY' };
        }
        if (orderQty > limit.maxOrderQty) {
            return {
                allowed: false,
                reason: 'EXCEEDS_MAX_ORDER_QTY',
                details: `Requested ${orderQty} exceeds max order limit of ${limit.maxOrderQty}`
            };
        }

        if (side === 'BUY') {
            const projectedLongExposure = pos.netPos + pos.workingBuys + orderQty;
            if (projectedLongExposure > limit.maxPosition) {
                return {
                    allowed: false,
                    reason: 'EXCEEDS_MAX_POSITION_LIMIT',
                    details: `Projected long position (${projectedLongExposure}) exceeds limit (${limit.maxPosition})`
                };
            }
        } else if (side === 'SELL') {
            const projectedShortExposure = Math.abs(pos.netPos - pos.workingSells - orderQty);
            if (projectedShortExposure > limit.maxPosition) {
                return {
                    allowed: false,
                    reason: 'EXCEEDS_MAX_POSITION_LIMIT',
                    details: `Projected short position (${projectedShortExposure}) exceeds limit (${limit.maxPosition})`
                };
            }
        }

        const effectivePrice = price || currentMarketPrice || 1.0;
        const multiplier = this.contractMultipliers[instrument] || 1;
        const orderNotional = orderQty * effectivePrice * multiplier;

        if (orderNotional > limit.maxNotional) {
            return {
                allowed: false,
                reason: 'EXCEEDS_MAX_NOTIONAL_LIMIT',
                details: `Order notional ($${orderNotional.toFixed(2)}) exceeds max allowed ($${limit.maxNotional})`
            };
        }

        return { allowed: true };
    }

    reserveWorkingMargin(order) {
        const pos = this.getPosition(order.traderId, order.instrument);
        const qty = parseInt(order.qty, 10);

        if (order.side === 'BUY') {
            pos.workingBuys += qty;
        } else {
            pos.workingSells += qty;
        }

        this.activeOrders.set(order.id, {
            id: order.id,
            traderId: order.traderId,
            instrument: order.instrument,
            side: order.side,
            qty,
            remainingQty: qty,
            price: order.price
        });
    }

    /**
     * Process Trade Fill: Updates Net Position, Weighted Average Price, Realized P&L,
     * and releases working order margin reservations.
     */
    onTrade(trade) {
        const { buyerId, sellerId, instrument, price, qty } = trade;
        const tradeQty = parseInt(qty, 10);
        const tradePrice = parseFloat(price);
        const multiplier = this.contractMultipliers[instrument] || 1;

        // 1. Process Buyer Side
        if (buyerId && buyerId !== 'MARKET_MAKER') {
            const pos = this.getPosition(buyerId, instrument);
            pos.buyQty += tradeQty;
            pos.workingBuys = Math.max(0, pos.workingBuys - tradeQty);

            if (pos.netPos >= 0) {
                const newNet = pos.netPos + tradeQty;
                pos.avgPx = (pos.netPos * pos.avgPx + tradeQty * tradePrice) / newNet;
                pos.netPos = newNet;
            } else {
                const currentShort = Math.abs(pos.netPos);
                const closingQty = Math.min(currentShort, tradeQty);
                pos.realizedPnl += (pos.avgPx - tradePrice) * closingQty * multiplier;
                pos.netPos += tradeQty;
                if (pos.netPos === 0) {
                    pos.avgPx = 0;
                } else if (pos.netPos > 0) {
                    pos.avgPx = tradePrice;
                }
            }
        }

        // 2. Process Seller Side
        if (sellerId && sellerId !== 'MARKET_MAKER') {
            const pos = this.getPosition(sellerId, instrument);
            pos.sellQty += tradeQty;
            pos.workingSells = Math.max(0, pos.workingSells - tradeQty);

            if (pos.netPos <= 0) {
                const currentShort = Math.abs(pos.netPos);
                const newShort = currentShort + tradeQty;
                pos.avgPx = (currentShort * pos.avgPx + tradeQty * tradePrice) / newShort;
                pos.netPos = -newShort;
            } else {
                const currentLong = pos.netPos;
                const closingQty = Math.min(currentLong, tradeQty);
                pos.realizedPnl += (tradePrice - pos.avgPx) * closingQty * multiplier;
                pos.netPos -= tradeQty;
                if (pos.netPos === 0) {
                    pos.avgPx = 0;
                } else if (pos.netPos < 0) {
                    pos.avgPx = tradePrice;
                }
            }
        }
    }

    onOrderEvent(event) {
        const { orderId, status, remainingQty } = event;
        const tracked = this.activeOrders.get(orderId);
        if (!tracked) return;

        if (status === 'CANCELLED' || status === 'REJECTED') {
            const pos = this.getPosition(tracked.traderId, tracked.instrument);
            const unreservedQty = tracked.remainingQty;

            if (tracked.side === 'BUY') {
                pos.workingBuys = Math.max(0, pos.workingBuys - unreservedQty);
            } else {
                pos.workingSells = Math.max(0, pos.workingSells - unreservedQty);
            }

            this.activeOrders.delete(orderId);
        } else if (status === 'FILLED') {
            this.activeOrders.delete(orderId);
        } else if (status === 'PARTIALLY_FILLED') {
            tracked.remainingQty = remainingQty !== undefined ? remainingQty : tracked.remainingQty;
        }
    }
}

module.exports = RiskEngine;