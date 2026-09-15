import type { DepthBook, PriceTicker } from './instrument';
import type { Fill, Order, PIQData, Position } from './order';

// Inbound messages from AppServer -> Client
export type WSInboundMessage =
    | { type: 'PRICE_UPDATE'; data: PriceTicker }
    | { type: 'BOOK_DEPTH'; data: DepthBook }
    | { type: 'ORDER_EVENT'; event: Order }
    | { type: 'ORDER_SUBMITTED'; orderId: string; instrument: string; side: string; price: number; qty: number; timestamp: string }
    | { type: 'TRADE'; data: Fill }
    | { type: 'PIQ_UPDATE'; data: PIQData }
    | { type: 'POSITION_UPDATE'; data: Position }
    | { type: 'RISK_EVENT'; data: { traderId: string; instrument: string; reason: string; message: string; timestamp: string } }
    | { type: 'CANCELLED'; orderId: string; instrument: string }
    | { type: 'HEARTBEAT'; timestamp: string }
    | { type: 'ERROR'; message: string; details?: any };

// Outbound actions from Client -> AppServer
export type WSOutboundAction =
    | { action: 'PLACE_ORDER'; instrument: string; side: 'BUY' | 'SELL'; type: 'LIMIT' | 'MARKET'; price: number; qty: number; tif: 'DAY' | 'GTC' | 'IOC' | 'FOK' }
    | { action: 'CANCEL_ORDER'; orderId: string; instrument: string }
    | { action: 'SUBSCRIBE'; rooms: string[] }
    | { action: 'UNSUBSCRIBE'; rooms: string[] }
    | { action: 'PING'; timestamp: number };