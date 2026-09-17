/**
 * Market Data Server (MDS)
 * Simulates realistic market-maker order flow and random-walk price dynamics.
 * Supports two modes: 'RANDOM_WALK' (simulation) and 'USER_DRIVEN' (manual/deterministic).
 */
class MDS {
    constructor(engineManager, kafkaProducer = null, mode = process.env.MDS_MODE || 'RANDOM_WALK') {
        this.engineManager = engineManager;
        this.kafkaProducer = kafkaProducer;
        this.mode = mode; // 'RANDOM_WALK' or 'USER_DRIVEN'
        this.isRunning = false;
        this.intervalId = null;

        // Instrument definitions with baseline start prices, tick sizes, and active quote tracking
        this.instruments = new Map([
            ['GC Dec27', { symbol: 'GC Dec27', exchange: 'COMEX', basePrice: 2650.00, tickSize: 0.10000, currentPrice: 2650.00, venueTopic: 'raw_orders_comex', activeQuotes: [] }],
            ['CL Dec27', { symbol: 'CL Dec27', exchange: 'NYMEX', basePrice: 78.50, tickSize: 0.01000, currentPrice: 78.50, venueTopic: 'raw_orders_nymex', activeQuotes: [] }],
            ['SR3 Dec27', { symbol: 'SR3 Dec27', exchange: 'CME', basePrice: 96.035, tickSize: 0.00500, currentPrice: 96.035, venueTopic: 'raw_orders_cme', activeQuotes: [] }],
            ['CRA Dec27', { symbol: 'CRA Dec27', exchange: 'MX', basePrice: 95.820, tickSize: 0.00500, currentPrice: 95.820, venueTopic: 'raw_orders_mx', activeQuotes: [] }],
            ['ER3 Jun26', { symbol: 'ER3 Jun26', exchange: 'ICE', basePrice: 97.210, tickSize: 0.00500, currentPrice: 97.210, venueTopic: 'raw_orders_ice', activeQuotes: [] }]
        ]);
    }

    /**
     * Set running mode dynamically ('RANDOM_WALK' or 'USER_DRIVEN')
     */
    setMode(mode) {
        this.mode = mode;
        if (mode === 'USER_DRIVEN') {
            for (const inst of this.instruments.values()) {
                const book = this.engineManager.getBook(inst.symbol);
                if (book && inst.activeQuotes && inst.activeQuotes.length > 0) {
                    for (const orderId of inst.activeQuotes) {
                        book.cancelOrder(orderId);
                    }
                    inst.activeQuotes = [];
                }
            }
            console.log(`[MDS] Mode switched to: USER_DRIVEN (Market Maker quotes cleared)`);
        } else {
            console.log(`[MDS] Mode switched to: RANDOM_WALK (Market Maker liquidity active)`);
        }

        // Trigger immediate tick to publish updated state/liquidity without waiting for interval
        if (this.isRunning) {
            this.tick().catch(err => {
                console.error('[MDS] Immediate tick failed after mode change:', err.message);
            });
        }
    }

    /**
     * Biased random walk with mean reversion
     */
    calculateNextPrice(inst) {
        const stepTicks = Math.floor(Math.random() * 7) - 3;
        let newPrice = inst.currentPrice + (stepTicks * inst.tickSize);

        const drift = (newPrice - inst.basePrice) / inst.basePrice;
        if (Math.abs(drift) > 0.05) {
            const pullDirection = drift > 0 ? -1 : 1;
            newPrice += (pullDirection * inst.tickSize * 2);
        }

        const minPrice = inst.basePrice * 0.90;
        const maxPrice = inst.basePrice * 1.10;
        newPrice = Math.max(minPrice, Math.min(maxPrice, newPrice));

        const tickCount = Math.round(newPrice / inst.tickSize);
        inst.currentPrice = Number((tickCount * inst.tickSize).toFixed(5));
        return inst.currentPrice;
    }

    /**
     * Seed / Update 10-level liquidity on both sides of the book (Cancel-and-Replace)
     */
    injectMarketMakerLiquidity(inst) {
        const book = this.engineManager.getBook(inst.symbol);
        if (!book) return;

        if (inst.activeQuotes && inst.activeQuotes.length > 0) {
            for (const orderId of inst.activeQuotes) {
                book.cancelOrder(orderId);
            }
        }
        inst.activeQuotes = [];

        const midPrice = inst.currentPrice;
        const tick = inst.tickSize;

        for (let i = 1; i <= 5; i++) {
            const askPrice = Number((midPrice + (i * tick)).toFixed(5));
            const askQty = Math.floor(Math.random() * 20) + 5;
            const orderId = `mm-ask-${inst.symbol}-${i}-${Date.now()}-${Math.random()}`;

            book.processOrder({
                id: orderId,
                traderId: 'MARKET_MAKER',
                instrument: inst.symbol,
                side: 'SELL',
                type: 'LIMIT',
                price: askPrice,
                qty: askQty,
                tif: 'GTC'
            });

            inst.activeQuotes.push(orderId);
        }

        for (let i = 1; i <= 5; i++) {
            const bidPrice = Number((midPrice - (i * tick)).toFixed(5));
            const bidQty = Math.floor(Math.random() * 20) + 5;
            const orderId = `mm-bid-${inst.symbol}-${i}-${Date.now()}-${Math.random()}`;

            book.processOrder({
                id: orderId,
                traderId: 'MARKET_MAKER',
                instrument: inst.symbol,
                side: 'BUY',
                type: 'LIMIT',
                price: bidPrice,
                qty: bidQty,
                tif: 'GTC'
            });

            inst.activeQuotes.push(orderId);
        }
    }

    /**
     * Single tick execution cycle (runs every 500ms)
     */
    async tick() {
        const priceUpdates = [];

        for (const [symbol, inst] of this.instruments.entries()) {
            if (this.mode === 'RANDOM_WALK') {
                this.calculateNextPrice(inst);
                this.injectMarketMakerLiquidity(inst);
            }

            const book = this.engineManager.getBook(symbol);
            const bestBid = book ? book.getBestBid() : null;
            const bestAsk = book ? book.getBestAsk() : null;
            const depth = book ? book.getDepth(10) : { bids: [], asks: [] };
            const currentVolume = book ? book.getTotalVolume() : 0;

            const priceUpdate = {
                instrument: symbol,
                bid: bestBid !== null ? bestBid : Number((inst.currentPrice - inst.tickSize).toFixed(5)),
                ask: bestAsk !== null ? bestAsk : Number((inst.currentPrice + inst.tickSize).toFixed(5)),
                bestBid: bestBid !== null ? bestBid : Number((inst.currentPrice - inst.tickSize).toFixed(5)),
                bestAsk: bestAsk !== null ? bestAsk : Number((inst.currentPrice + inst.tickSize).toFixed(5)),
                bids: depth.bids,
                asks: depth.asks,
                last: inst.currentPrice,
                volume: currentVolume,
                time: new Date().toISOString()
            };
            priceUpdates.push(priceUpdate);

            if (this.kafkaProducer) {
                try {
                    await this.kafkaProducer.send({
                        topic: 'prices',
                        messages: [{
                            key: symbol,
                            value: JSON.stringify(priceUpdate)
                        }]
                    });
                } catch (err) {
                    console.error(`[MDS] Error publishing price update for ${symbol}:`, err.message);
                }
            }
        }

        return priceUpdates;
    }

    start(intervalMs = 500) {
        if (this.isRunning) return;
        this.isRunning = true;

        if (this.mode === 'RANDOM_WALK') {
            for (const inst of this.instruments.values()) {
                this.injectMarketMakerLiquidity(inst);
            }
        }

        this.intervalId = setInterval(() => this.tick(), intervalMs);
        if (this.intervalId.unref) {
            this.intervalId.unref();
        }
        console.log(`[MDS] Market Data Server started (Mode: ${this.mode}, Interval: ${intervalMs}ms)`);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('[MDS] Market Data Server stopped');
    }
}

module.exports = MDS;