// import { Instrument } from './instrument';
// import { Fill, Order, Position, RiskLimit } from './order';

export interface LoginRequest {
    username: string;
    password?: string;
}

export interface LoginResponse {
    traderId: string;
    username: string;
    token: string;
}

export interface TraderUser {
    id: string;
    username: string;
}

export interface OHLCVCandle {
    time: number;       // Unix timestamp in seconds (for Lightweight Charts)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}