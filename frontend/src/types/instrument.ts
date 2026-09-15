export interface Instrument {
    symbol: string;         // e.g. "GC Dec27"
    description: string;    // e.g. "Gold Futures Dec 2027"
    exchange: string;       // e.g. "COMEX"
    family: string;         // e.g. "GC"
    tickSize: number;       // e.g. 0.10
    lotSize: number;        // e.g. 100
    startPrice: number;     // e.g. 2650.00
}

export interface PriceLevel {
    size: number;
    price: number;
    qty: number;
    orderCount?: number;
}

export interface DepthBook {
    instrument: string;
    bids: PriceLevel[];     // Sorted descending by price
    asks: PriceLevel[];     // Sorted ascending by price
    timestamp: string;
}

export interface PriceTicker {
    instrument: string;
    bid: number;
    ask: number;
    last: number;
    lastQty?: number;
    high?: number;
    low?: number;
    open?: number;
    volume: number;
    change?: number;
    timestamp: string;
}