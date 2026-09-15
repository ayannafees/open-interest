// const crypto = require('crypto');

// /**
//  * OrderBook represents an isolated, in-memory matching engine for a single financial contract.
//  */
// class OrderBook {
//     constructor(symbol, tickSize) {
//         this.symbol = symbol;
//         this.tickSize = tickSize;

//         // Price level maps: priceTicks (integer) -> PriceLevel object
//         this.bids = new Map(); // Sorted descending (highest price first)
//         this.asks = new Map(); // Sorted ascending (lowest price first)

//         // O(1) order lookup for fast cancellations: orderId -> Order
//         this.orders = new Map();

//         // Idempotency cache: orderId -> timestamp (prevents duplicate processing)
//         this.seen = new Map();

//         // Clean up idempotency cache every 60 seconds (evicts items older than 1 hour)
//         this.cleanupInterval = setInterval(() => this.cleanupSeenCache(), 60000);
//         if (this.cleanupInterval.unref) {
//             this.cleanupInterval.unref(); // Tells Node: "Don't keep the process alive just for this timer"
//         }
//     }

//     /**
//      * Convert floating point price to discrete integer ticks (EX-01)
//      */
//     priceToTicks(price) {
//         return Math.round(price / this.tickSize);
//     }

//     /**
//      * Convert integer ticks back to floating point price
//      */
//     ticksToPrice(ticks) {
//         return Number((ticks * this.tickSize).toFixed(5));
//     }

//     /**
//      * Evict seen cache entries older than 1 hour (bounded RAM)
//      */
//     cleanupSeenCache() {
//         const oneHourAgo = Date.now() - 3600000;
//         for (const [orderId, timestamp] of this.seen.entries()) {
//             if (timestamp < oneHourAgo) {
//                 this.seen.delete(orderId);
//             }
//         }
//     }

//     /**
//      * Helper to get sorted price tick keys
//      */
//     getSortedBidTicks() {
//         return Array.from(this.bids.keys()).sort((a, b) => b - a); // Descending (high to low)
//     }

//     getSortedAskTicks() {
//         return Array.from(this.asks.keys()).sort((a, b) => a - b); // Ascending (low to high)
//     }

//     /**
//      * Pre-check available crossing liquidity for FOK (Fill-Or-Kill) orders
//      */
//     calculateAvailableLiquidity(incomingOrder, targetTicks) {
//         const isBuy = incomingOrder.side === 'BUY';
//         const opposingMap = isBuy ? this.asks : this.bids;
//         const sortedTicks = isBuy ? this.getSortedAskTicks() : this.getSortedBidTicks();

//         let totalAvailable = 0;
//         for (const ticks of sortedTicks) {
//             // Check if price crosses
//             if (isBuy && ticks > targetTicks) break;
//             if (!isBuy && ticks < targetTicks) break;

//             const level = opposingMap.get(ticks);
//             if (!level) continue;

//             for (const resting of level.queue) {
//                 // Exclude self-trades (EX-02)
//                 if (resting.traderId !== incomingOrder.traderId) {
//                     totalAvailable += resting.qty;
//                 }
//             }
//         }
//         return totalAvailable;
//     }

//     /**
//      * Core Matching Algorithm (Price-Time Priority FIFO)
//      */
//     processOrder(incomingOrder) {
//         const events = [];
//         const trades = [];

//         // Validation: Invalid Quantity
//         if (!incomingOrder.qty || incomingOrder.qty <= 0) {
//             events.push({
//                 type: 'ORDER_EVENT',
//                 orderId: incomingOrder.id,
//                 traderId: incomingOrder.traderId,
//                 instrument: this.symbol,
//                 status: 'REJECTED',
//                 reason: 'INVALID_QTY',
//                 remainingQty: 0,
//                 timestamp: new Date().toISOString()
//             });
//             return { trades, events };
//         }

//         // Idempotency: Reject duplicate order IDs (EX-04)
//         if (this.seen.has(incomingOrder.id)) {
//             events.push({
//                 type: 'ORDER_EVENT',
//                 orderId: incomingOrder.id,
//                 traderId: incomingOrder.traderId,
//                 instrument: this.symbol,
//                 status: 'REJECTED',
//                 reason: 'DUPLICATE_ORDER_ID',
//                 remainingQty: incomingOrder.qty,
//                 timestamp: new Date().toISOString()
//             });
//             return { trades, events };
//         }
//         this.seen.set(incomingOrder.id, Date.now());

//         // Normalize order fields
//         const isBuy = incomingOrder.side === 'BUY';
//         const isMarket = incomingOrder.type === 'MARKET';
//         const targetTicks = isMarket ? (isBuy ? Infinity : -Infinity) : this.priceToTicks(incomingOrder.price);

//         let remainingQty = incomingOrder.qty;
//         let filledQty = 0;

//         // Step A: FOK Pre-Check
//         if (incomingOrder.tif === 'FOK') {
//             const availableLiquidity = this.calculateAvailableLiquidity(incomingOrder, targetTicks);
//             if (availableLiquidity < incomingOrder.qty) {
//                 events.push({
//                     type: 'ORDER_EVENT',
//                     orderId: incomingOrder.id,
//                     traderId: incomingOrder.traderId,
//                     instrument: this.symbol,
//                     status: 'REJECTED',
//                     reason: 'FOK_INSUFFICIENT_LIQUIDITY',
//                     remainingQty: 0,
//                     timestamp: new Date().toISOString()
//                 });
//                 return { trades, events };
//             }
//         }

//         // Step B: Crossing Sweep Loop
//         const opposingMap = isBuy ? this.asks : this.bids;
//         const sortedTicks = isBuy ? this.getSortedAskTicks() : this.getSortedBidTicks();

//         for (const ticks of sortedTicks) {
//             if (remainingQty === 0) break;

//             // Crossing check
//             if (isBuy && ticks > targetTicks) break; // Asks are too expensive for buyer limit
//             if (!isBuy && ticks < targetTicks) break; // Bids are too cheap for seller limit

//             const level = opposingMap.get(ticks);
//             if (!level) continue;

//             let queueIndex = 0;
//             while (queueIndex < level.queue.length && remainingQty > 0) {
//                 const restingOrder = level.queue[queueIndex];

//                 // Self-Trade Prevention (EX-02)
//                 if (incomingOrder.traderId === restingOrder.traderId) {
//                     events.push({
//                         type: 'ORDER_EVENT',
//                         orderId: incomingOrder.id,
//                         traderId: incomingOrder.traderId,
//                         instrument: this.symbol,
//                         status: 'REJECTED',
//                         reason: 'STP_SELF_TRADE_PREVENTED',
//                         remainingQty: remainingQty,
//                         timestamp: new Date().toISOString()
//                     });
//                     queueIndex++;
//                     continue;
//                 }

//                 const matchQty = Math.min(remainingQty, restingOrder.qty);
//                 const matchPrice = level.price;

//                 // Create Trade Event
//                 const trade = {
//                     id: crypto.randomUUID(),
//                     buyerId: isBuy ? incomingOrder.traderId : restingOrder.traderId,
//                     sellerId: isBuy ? restingOrder.traderId : incomingOrder.traderId,
//                     buyerOrderId: isBuy ? incomingOrder.id : restingOrder.id,
//                     sellerOrderId: isBuy ? restingOrder.id : incomingOrder.id,
//                     instrument: this.symbol,
//                     price: matchPrice,
//                     qty: matchQty,
//                     aggressorSide: incomingOrder.side,
//                     bestBid: this.getBestBid(),
//                     bestAsk: this.getBestAsk(),
//                     time: new Date().toISOString()
//                 };
//                 trades.push(trade);

//                 remainingQty -= matchQty;
//                 filledQty += matchQty;
//                 level.totalQty -= matchQty;

//                 // In-Place Queue Decrement (EX-09)
//                 restingOrder.qty -= matchQty;
//                 restingOrder.filledQty = (restingOrder.filledQty || 0) + matchQty;

//                 if (restingOrder.qty === 0) {
//                     // Fully filled resting order
//                     level.queue.splice(queueIndex, 1);
//                     this.orders.delete(restingOrder.id);
//                     events.push({
//                         type: 'ORDER_EVENT',
//                         orderId: restingOrder.id,
//                         traderId: restingOrder.traderId,
//                         instrument: this.symbol,
//                         status: 'FILLED',
//                         filledQty: restingOrder.filledQty,
//                         remainingQty: 0,
//                         avgPrice: matchPrice,
//                         timestamp: new Date().toISOString()
//                     });
//                 } else {
//                     // Partially filled resting order (retains FIFO head position)
//                     events.push({
//                         type: 'ORDER_EVENT',
//                         orderId: restingOrder.id,
//                         traderId: restingOrder.traderId,
//                         instrument: this.symbol,
//                         status: 'PARTIALLY_FILLED',
//                         filledQty: restingOrder.filledQty,
//                         remainingQty: restingOrder.qty,
//                         avgPrice: matchPrice,
//                         timestamp: new Date().toISOString()
//                     });
//                     queueIndex++;
//                 }
//             }

//             // If price level is empty, remove it from map
//             if (level.queue.length === 0 || level.totalQty === 0) {
//                 opposingMap.delete(ticks);
//             }
//         }

//         // Step C: Handle Incoming Order Lifecycle Events
//         if (filledQty > 0) {
//             if (remainingQty === 0) {
//                 events.push({
//                     type: 'ORDER_EVENT',
//                     orderId: incomingOrder.id,
//                     traderId: incomingOrder.traderId,
//                     instrument: this.symbol,
//                     status: 'FILLED',
//                     filledQty: filledQty,
//                     remainingQty: 0,
//                     timestamp: new Date().toISOString()
//                 });
//             } else {
//                 events.push({
//                     type: 'ORDER_EVENT',
//                     orderId: incomingOrder.id,
//                     traderId: incomingOrder.traderId,
//                     instrument: this.symbol,
//                     status: 'PARTIALLY_FILLED',
//                     filledQty: filledQty,
//                     remainingQty: remainingQty,
//                     timestamp: new Date().toISOString()
//                 });
//             }
//         }

//         // Step D: Remainder Handling by TIF
//         if (remainingQty > 0) {
//             if (isMarket || incomingOrder.tif === 'IOC' || incomingOrder.tif === 'FOK') {
//                 // Market, IOC, and FOK orders NEVER rest in the book
//                 events.push({
//                     type: 'ORDER_EVENT',
//                     orderId: incomingOrder.id,
//                     traderId: incomingOrder.traderId,
//                     instrument: this.symbol,
//                     status: 'CANCELLED',
//                     reason: isMarket ? 'MARKET_UNFILLED_REMAINDER' : 'IOC_UNFILLED_REMAINDER',
//                     filledQty: filledQty,
//                     remainingQty: remainingQty,
//                     timestamp: new Date().toISOString()
//                 });
//             } else {
//                 // DAY or GTC orders rest in the book
//                 this.restOrder({
//                     ...incomingOrder,
//                     priceTicks: targetTicks,
//                     price: isMarket ? this.ticksToPrice(targetTicks) : incomingOrder.price,
//                     qty: remainingQty,
//                     initialQty: incomingOrder.qty,
//                     filledQty: filledQty
//                 });

//                 events.push({
//                     type: 'ORDER_EVENT',
//                     orderId: incomingOrder.id,
//                     traderId: incomingOrder.traderId,
//                     instrument: this.symbol,
//                     status: filledQty > 0 ? 'PARTIALLY_FILLED' : 'WORKING',
//                     filledQty: filledQty,
//                     remainingQty: remainingQty,
//                     price: incomingOrder.price,
//                     timestamp: new Date().toISOString()
//                 });
//             }
//         }

//         return { trades, events };
//     }

//     /**
//      * Place an order into resting book
//      */
//     restOrder(order) {
//         const targetMap = order.side === 'BUY' ? this.bids : this.asks;
//         let level = targetMap.get(order.priceTicks);

//         if (!level) {
//             level = {
//                 price: order.price,
//                 priceTicks: order.priceTicks,
//                 totalQty: 0,
//                 queue: []
//             };
//             targetMap.set(order.priceTicks, level);
//         }

//         level.totalQty += order.qty;
//         level.queue.push(order);
//         this.orders.set(order.id, order);
//     }

//     /**
//      * Safe Order Cancellation Guard (EX-03)
//      */
//     cancelOrder(orderId) {
//         const order = this.orders.get(orderId);
//         if (!order) {
//             return {
//                 success: false,
//                 event: {
//                     type: 'ORDER_EVENT',
//                     orderId: orderId,
//                     status: 'CANCEL_REJECTED',
//                     reason: 'ORDER_NOT_FOUND_OR_ALREADY_FILLED',
//                     timestamp: new Date().toISOString()
//                 }
//             };
//         }

//         const targetMap = order.side === 'BUY' ? this.bids : this.asks;
//         const level = targetMap.get(order.priceTicks);

//         if (level) {
//             const idx = level.queue.findIndex(o => o.id === orderId);
//             if (idx !== -1) {
//                 level.queue.splice(idx, 1);
//                 level.totalQty -= order.qty;
//             }
//             if (level.queue.length === 0 || level.totalQty === 0) {
//                 targetMap.delete(order.priceTicks);
//             }
//         }

//         this.orders.delete(orderId);

//         return {
//             success: true,
//             event: {
//                 type: 'ORDER_EVENT',
//                 orderId: order.id,
//                 traderId: order.traderId,
//                 instrument: this.symbol,
//                 status: 'CANCELLED',
//                 reason: 'USER_CANCELLED',
//                 remainingQty: order.qty,
//                 timestamp: new Date().toISOString()
//             }
//         };
//     }

//     /**
//      * Get current Best Bid price
//      */
//     getBestBid() {
//         const bidTicks = this.getSortedBidTicks();
//         return bidTicks.length > 0 ? this.bids.get(bidTicks[0]).price : null;
//     }

//     /**
//      * Get current Best Ask price
//      */
//     getBestAsk() {
//         const askTicks = this.getSortedAskTicks();
//         return askTicks.length > 0 ? this.asks.get(askTicks[0]).price : null;
//     }

//     /**
//      * Generate 20-level order book depth snapshot for Ladder and UI
//      */
//     getDepth(levels = 20) {
//         const bids = [];
//         const asks = [];

//         const sortedBidTicks = this.getSortedBidTicks();
//         for (let i = 0; i < Math.min(levels, sortedBidTicks.length); i++) {
//             const level = this.bids.get(sortedBidTicks[i]);
//             bids.push({ price: level.price, qty: level.totalQty, ordersCount: level.queue.length });
//         }

//         const sortedAskTicks = this.getSortedAskTicks();
//         for (let i = 0; i < Math.min(levels, sortedAskTicks.length); i++) {
//             const level = this.asks.get(sortedAskTicks[i]);
//             asks.push({ price: level.price, qty: level.totalQty, ordersCount: level.queue.length });
//         }

//         return {
//             instrument: this.symbol,
//             bids,
//             asks,
//             bestBid: this.getBestBid(),
//             bestAsk: this.getBestAsk(),
//             timestamp: new Date().toISOString()
//         };
//     }
// }

// /**
//  * MatchingEngineManager manages independent OrderBook instances for each contract.
//  */
// class MatchingEngineManager {
//     constructor() {
//         this.books = new Map();
//     }

//     registerInstrument(symbol, tickSize) {
//         if (!this.books.has(symbol)) {
//             this.books.set(symbol, new OrderBook(symbol, tickSize));
//         }
//         return this.books.get(symbol);
//     }

//     getBook(symbol) {
//         return this.books.get(symbol);
//     }

//     processOrder(order) {
//         const book = this.getBook(order.instrument);
//         if (!book) {
//             return {
//                 trades: [],
//                 events: [{
//                     type: 'ORDER_EVENT',
//                     orderId: order.id,
//                     traderId: order.traderId,
//                     instrument: order.instrument,
//                     status: 'REJECTED',
//                     reason: 'UNKNOWN_INSTRUMENT',
//                     timestamp: new Date().toISOString()
//                 }]
//             };
//         }
//         return book.processOrder(order);
//     }

//     cancelOrder(symbol, orderId) {
//         const book = this.getBook(symbol);
//         if (!book) {
//             return {
//                 success: false,
//                 event: {
//                     type: 'ORDER_EVENT',
//                     orderId,
//                     status: 'CANCEL_REJECTED',
//                     reason: 'UNKNOWN_INSTRUMENT',
//                     timestamp: new Date().toISOString()
//                 }
//             };
//         }
//         return book.cancelOrder(orderId);
//     }
// }

// module.exports = {
//     OrderBook,
//     MatchingEngineManager
// };

const crypto = require('crypto');

/**
 * OrderBook represents an isolated, in-memory matching engine for a single financial contract.
 */
class OrderBook {
    constructor(symbol, tickSize) {
        this.symbol = symbol;
        this.tickSize = tickSize;

        // Price level maps: priceTicks (integer) -> PriceLevel object
        this.bids = new Map(); // Sorted descending (highest price first)
        this.asks = new Map(); // Sorted ascending (lowest price first)

        // O(1) order lookup for fast cancellations: orderId -> Order
        this.orders = new Map();

        // Idempotency cache: orderId -> timestamp (prevents duplicate processing)
        this.seen = new Map();

        // Cumulative traded volume in lots for this session
        this.totalVolume = 0;

        // Clean up idempotency cache every 60 seconds (evicts items older than 1 hour)
        this.cleanupInterval = setInterval(() => this.cleanupSeenCache(), 60000);
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref(); // Tells Node: "Don't keep the process alive just for this timer"
        }
    }

    /**
     * Get cumulative traded lots
     */
    getTotalVolume() {
        return this.totalVolume;
    }

    /**
     * Set starting traded lots (for DB rehydration on boot)
     */
    setTotalVolume(vol) {
        this.totalVolume = parseInt(vol, 10) || 0;
    }

    /**
     * Convert floating point price to discrete integer ticks (EX-01)
     */
    priceToTicks(price) {
        return Math.round(price / this.tickSize);
    }

    /**
     * Convert integer ticks back to floating point price
     */
    ticksToPrice(ticks) {
        return Number((ticks * this.tickSize).toFixed(5));
    }

    /**
     * Evict seen cache entries older than 1 hour (bounded RAM)
     */
    cleanupSeenCache() {
        const oneHourAgo = Date.now() - 3600000;
        for (const [orderId, timestamp] of this.seen.entries()) {
            if (timestamp < oneHourAgo) {
                this.seen.delete(orderId);
            }
        }
    }

    /**
     * Helper to get sorted price tick keys
     */
    getSortedBidTicks() {
        return Array.from(this.bids.keys()).sort((a, b) => b - a); // Descending (high to low)
    }

    getSortedAskTicks() {
        return Array.from(this.asks.keys()).sort((a, b) => a - b); // Ascending (low to high)
    }

    /**
     * Pre-check available crossing liquidity for FOK (Fill-Or-Kill) orders
     */
    calculateAvailableLiquidity(incomingOrder, targetTicks) {
        const isBuy = incomingOrder.side === 'BUY';
        const opposingMap = isBuy ? this.asks : this.bids;
        const sortedTicks = isBuy ? this.getSortedAskTicks() : this.getSortedBidTicks();

        let totalAvailable = 0;
        for (const ticks of sortedTicks) {
            // Check if price crosses
            if (isBuy && ticks > targetTicks) break;
            if (!isBuy && ticks < targetTicks) break;

            const level = opposingMap.get(ticks);
            if (!level) continue;

            for (const resting of level.queue) {
                // Exclude self-trades (EX-02)
                if (resting.traderId !== incomingOrder.traderId) {
                    totalAvailable += resting.qty;
                }
            }
        }
        return totalAvailable;
    }

    /**
     * Core Matching Algorithm (Price-Time Priority FIFO)
     */
    processOrder(incomingOrder) {
        const events = [];
        const trades = [];

        // Validation: Invalid Quantity
        if (!incomingOrder.qty || incomingOrder.qty <= 0) {
            events.push({
                type: 'ORDER_EVENT',
                orderId: incomingOrder.id,
                traderId: incomingOrder.traderId,
                instrument: this.symbol,
                status: 'REJECTED',
                reason: 'INVALID_QTY',
                remainingQty: 0,
                timestamp: new Date().toISOString()
            });
            return { trades, events };
        }

        // Idempotency: Reject duplicate order IDs (EX-04)
        if (this.seen.has(incomingOrder.id)) {
            events.push({
                type: 'ORDER_EVENT',
                orderId: incomingOrder.id,
                traderId: incomingOrder.traderId,
                instrument: this.symbol,
                status: 'REJECTED',
                reason: 'DUPLICATE_ORDER_ID',
                remainingQty: incomingOrder.qty,
                timestamp: new Date().toISOString()
            });
            return { trades, events };
        }
        this.seen.set(incomingOrder.id, Date.now());

        // Normalize order fields
        const isBuy = incomingOrder.side === 'BUY';
        const isMarket = incomingOrder.type === 'MARKET';
        const targetTicks = isMarket ? (isBuy ? Infinity : -Infinity) : this.priceToTicks(incomingOrder.price);

        let remainingQty = incomingOrder.qty;
        let filledQty = 0;

        // Step A: FOK Pre-Check
        if (incomingOrder.tif === 'FOK') {
            const availableLiquidity = this.calculateAvailableLiquidity(incomingOrder, targetTicks);
            if (availableLiquidity < incomingOrder.qty) {
                events.push({
                    type: 'ORDER_EVENT',
                    orderId: incomingOrder.id,
                    traderId: incomingOrder.traderId,
                    instrument: this.symbol,
                    status: 'REJECTED',
                    reason: 'FOK_INSUFFICIENT_LIQUIDITY',
                    remainingQty: 0,
                    timestamp: new Date().toISOString()
                });
                return { trades, events };
            }
        }

        // Step B: Crossing Sweep Loop
        const opposingMap = isBuy ? this.asks : this.bids;
        const sortedTicks = isBuy ? this.getSortedAskTicks() : this.getSortedBidTicks();

        for (const ticks of sortedTicks) {
            if (remainingQty === 0) break;

            // Crossing check
            if (isBuy && ticks > targetTicks) break; // Asks are too expensive for buyer limit
            if (!isBuy && ticks < targetTicks) break; // Bids are too cheap for seller limit

            const level = opposingMap.get(ticks);
            if (!level) continue;

            let queueIndex = 0;
            while (queueIndex < level.queue.length && remainingQty > 0) {
                const restingOrder = level.queue[queueIndex];

                // Self-Trade Prevention (EX-02)
                if (incomingOrder.traderId === restingOrder.traderId) {
                    events.push({
                        type: 'ORDER_EVENT',
                        orderId: incomingOrder.id,
                        traderId: incomingOrder.traderId,
                        instrument: this.symbol,
                        status: 'REJECTED',
                        reason: 'STP_SELF_TRADE_PREVENTED',
                        remainingQty: remainingQty,
                        timestamp: new Date().toISOString()
                    });
                    queueIndex++;
                    continue;
                }

                const matchQty = Math.min(remainingQty, restingOrder.qty);
                const matchPrice = level.price;

                // Create Trade Event
                const trade = {
                    id: crypto.randomUUID(),
                    buyerId: isBuy ? incomingOrder.traderId : restingOrder.traderId,
                    sellerId: isBuy ? restingOrder.traderId : incomingOrder.traderId,
                    buyerOrderId: isBuy ? incomingOrder.id : restingOrder.id,
                    sellerOrderId: isBuy ? restingOrder.id : incomingOrder.id,
                    instrument: this.symbol,
                    price: matchPrice,
                    qty: matchQty,
                    aggressorSide: incomingOrder.side,
                    bestBid: this.getBestBid(),
                    bestAsk: this.getBestAsk(),
                    time: new Date().toISOString()
                };
                trades.push(trade);

                // Accumulate matched volume into session total
                this.totalVolume += matchQty;

                remainingQty -= matchQty;
                filledQty += matchQty;
                level.totalQty -= matchQty;

                // In-Place Queue Decrement (EX-09)
                restingOrder.qty -= matchQty;
                restingOrder.filledQty = (restingOrder.filledQty || 0) + matchQty;

                if (restingOrder.qty === 0) {
                    // Fully filled resting order
                    level.queue.splice(queueIndex, 1);
                    this.orders.delete(restingOrder.id);
                    events.push({
                        type: 'ORDER_EVENT',
                        orderId: restingOrder.id,
                        traderId: restingOrder.traderId,
                        instrument: this.symbol,
                        status: 'FILLED',
                        filledQty: restingOrder.filledQty,
                        remainingQty: 0,
                        avgPrice: matchPrice,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    // Partially filled resting order (retains FIFO head position)
                    events.push({
                        type: 'ORDER_EVENT',
                        orderId: restingOrder.id,
                        traderId: restingOrder.traderId,
                        instrument: this.symbol,
                        status: 'PARTIALLY_FILLED',
                        filledQty: restingOrder.filledQty,
                        remainingQty: restingOrder.qty,
                        avgPrice: matchPrice,
                        timestamp: new Date().toISOString()
                    });
                    queueIndex++;
                }
            }

            // If price level is empty, remove it from map
            if (level.queue.length === 0 || level.totalQty === 0) {
                opposingMap.delete(ticks);
            }
        }

        // Step C: Handle Incoming Order Lifecycle Events
        if (filledQty > 0) {
            if (remainingQty === 0) {
                events.push({
                    type: 'ORDER_EVENT',
                    orderId: incomingOrder.id,
                    traderId: incomingOrder.traderId,
                    instrument: this.symbol,
                    status: 'FILLED',
                    filledQty: filledQty,
                    remainingQty: 0,
                    timestamp: new Date().toISOString()
                });
            } else {
                events.push({
                    type: 'ORDER_EVENT',
                    orderId: incomingOrder.id,
                    traderId: incomingOrder.traderId,
                    instrument: this.symbol,
                    status: 'PARTIALLY_FILLED',
                    filledQty: filledQty,
                    remainingQty: remainingQty,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // Step D: Remainder Handling by TIF
        if (remainingQty > 0) {
            if (isMarket || incomingOrder.tif === 'IOC' || incomingOrder.tif === 'FOK') {
                // Market, IOC, and FOK orders NEVER rest in the book
                events.push({
                    type: 'ORDER_EVENT',
                    orderId: incomingOrder.id,
                    traderId: incomingOrder.traderId,
                    instrument: this.symbol,
                    status: 'CANCELLED',
                    reason: isMarket ? 'MARKET_UNFILLED_REMAINDER' : 'IOC_UNFILLED_REMAINDER',
                    filledQty: filledQty,
                    remainingQty: remainingQty,
                    timestamp: new Date().toISOString()
                });
            } else {
                // DAY or GTC orders rest in the book
                this.restOrder({
                    ...incomingOrder,
                    priceTicks: targetTicks,
                    price: isMarket ? this.ticksToPrice(targetTicks) : incomingOrder.price,
                    qty: remainingQty,
                    initialQty: incomingOrder.qty,
                    filledQty: filledQty
                });

                events.push({
                    type: 'ORDER_EVENT',
                    orderId: incomingOrder.id,
                    traderId: incomingOrder.traderId,
                    instrument: this.symbol,
                    status: filledQty > 0 ? 'PARTIALLY_FILLED' : 'WORKING',
                    filledQty: filledQty,
                    remainingQty: remainingQty,
                    price: incomingOrder.price,
                    timestamp: new Date().toISOString()
                });
            }
        }

        return { trades, events };
    }

    /**
     * Place an order into resting book
     */
    restOrder(order) {
        const targetMap = order.side === 'BUY' ? this.bids : this.asks;
        let level = targetMap.get(order.priceTicks);

        if (!level) {
            level = {
                price: order.price,
                priceTicks: order.priceTicks,
                totalQty: 0,
                queue: []
            };
            targetMap.set(order.priceTicks, level);
        }

        level.totalQty += order.qty;
        level.queue.push(order);
        this.orders.set(order.id, order);
    }

    /**
     * Safe Order Cancellation Guard (EX-03)
     */
    cancelOrder(orderId) {
        const order = this.orders.get(orderId);
        if (!order) {
            return {
                success: false,
                event: {
                    type: 'ORDER_EVENT',
                    orderId: orderId,
                    status: 'CANCEL_REJECTED',
                    reason: 'ORDER_NOT_FOUND_OR_ALREADY_FILLED',
                    timestamp: new Date().toISOString()
                }
            };
        }

        const targetMap = order.side === 'BUY' ? this.bids : this.asks;
        const level = targetMap.get(order.priceTicks);

        if (level) {
            const idx = level.queue.findIndex(o => o.id === orderId);
            if (idx !== -1) {
                level.queue.splice(idx, 1);
                level.totalQty -= order.qty;
            }
            if (level.queue.length === 0 || level.totalQty === 0) {
                targetMap.delete(order.priceTicks);
            }
        }

        this.orders.delete(orderId);

        return {
            success: true,
            event: {
                type: 'ORDER_EVENT',
                orderId: order.id,
                traderId: order.traderId,
                instrument: this.symbol,
                status: 'CANCELLED',
                reason: 'USER_CANCELLED',
                remainingQty: order.qty,
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Get current Best Bid price
     */
    getBestBid() {
        const bidTicks = this.getSortedBidTicks();
        return bidTicks.length > 0 ? this.bids.get(bidTicks[0]).price : null;
    }

    /**
     * Get current Best Ask price
     */
    getBestAsk() {
        const askTicks = this.getSortedAskTicks();
        return askTicks.length > 0 ? this.asks.get(askTicks[0]).price : null;
    }

    /**
     * Generate 20-level order book depth snapshot for Ladder and UI
     */
    getDepth(levels = 20) {
        const bids = [];
        const asks = [];

        const sortedBidTicks = this.getSortedBidTicks();
        for (let i = 0; i < Math.min(levels, sortedBidTicks.length); i++) {
            const level = this.bids.get(sortedBidTicks[i]);
            bids.push({ price: level.price, qty: level.totalQty, ordersCount: level.queue.length });
        }

        const sortedAskTicks = this.getSortedAskTicks();
        for (let i = 0; i < Math.min(levels, sortedAskTicks.length); i++) {
            const level = this.asks.get(sortedAskTicks[i]);
            asks.push({ price: level.price, qty: level.totalQty, ordersCount: level.queue.length });
        }

        return {
            instrument: this.symbol,
            bids,
            asks,
            bestBid: this.getBestBid(),
            bestAsk: this.getBestAsk(),
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * MatchingEngineManager manages independent OrderBook instances for each contract.
 */
class MatchingEngineManager {
    constructor() {
        this.books = new Map();
    }

    registerInstrument(symbol, tickSize) {
        if (!this.books.has(symbol)) {
            this.books.set(symbol, new OrderBook(symbol, tickSize));
        }
        return this.books.get(symbol);
    }

    getBook(symbol) {
        return this.books.get(symbol);
    }

    processOrder(order) {
        const book = this.getBook(order.instrument);
        if (!book) {
            return {
                trades: [],
                events: [{
                    type: 'ORDER_EVENT',
                    orderId: order.id,
                    traderId: order.traderId,
                    instrument: order.instrument,
                    status: 'REJECTED',
                    reason: 'UNKNOWN_INSTRUMENT',
                    timestamp: new Date().toISOString()
                }]
            };
        }
        return book.processOrder(order);
    }

    cancelOrder(symbol, orderId) {
        const book = this.getBook(symbol);
        if (!book) {
            return {
                success: false,
                event: {
                    type: 'ORDER_EVENT',
                    orderId,
                    status: 'CANCEL_REJECTED',
                    reason: 'UNKNOWN_INSTRUMENT',
                    timestamp: new Date().toISOString()
                }
            };
        }
        return book.cancelOrder(orderId);
    }
}

module.exports = {
    OrderBook,
    MatchingEngineManager
};