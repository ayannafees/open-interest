export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';
export type OrderTIF = 'DAY' | 'GTC' | 'IOC' | 'FOK';
export type OrderStatus =
    | 'SUBMITTED'
    | 'WORKING'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'REJECTED'
    | 'CANCELLING';

export interface Order {
    id: string;
    traderId: string;
    instrument: string;
    side: OrderSide;
    type: OrderType;
    price: number;
    qty: number;
    filledQty: number;
    remainingQty: number;
    status: OrderStatus;
    tif: OrderTIF;
    rejectReason?: string;
    createdAt: string;
    updatedAt: string;
}

export interface Fill {
    id: string;
    orderId: string;
    buyerId: string;
    sellerId: string;
    instrument: string;
    side: OrderSide;
    price: number;
    qty: number;
    time: string;
    aggressorSide?: OrderSide;
}

export interface FillAlertItem {
    id: string;
    transactTime: string; // Millisecond ISO string
    exchange: string;     // CME, COMEX, NYMEX, MX, ICE
    contract: string;     // GC Dec27, SR3 Dec27, etc.
    side: OrderSide;
    filledQty: number;    // Execution fill size
    price: number;        // Execution fill price
    exeQty: number;       // Cumulative / total executed lots
    orderId?: string;
    notional?: number;
    account?: string;
}

export interface Position {
    traderId: string;
    instrument: string;
    sodPos: number;
    sodPx: number;
    buyQty: number;
    sellQty: number;
    netPos: number;
    avgPx: number;
    realizedPl: number;
    unrealizedPl?: number;
    lastPx?: number;
    settlePx?: number;
}

export interface RiskLimit {
    id: string;
    traderId: string;
    instrument: string;
    maxLong: number;
    maxShort: number;
    maxOrderQtyOutrights: number;
    maxOrderQtySpreads: number;
    tradeAllowed: boolean;
    limitVersion: number;
}

export interface PIQData {
    deltaTicks: any;
    orderId: string;
    instrument: string;
    side: OrderSide;
    price: number;
    queueRank: number;
    aheadQty: number;
    behindQty: number;
    totalLevelQty: number;
    fillProbability: number; // 0.0 to 1.0 (ρ)
    timestamp: string;
}