export interface InstrumentMeta {
    symbol: string;
    name: string;
    exchange: string;
    tickSize: number;
    decimals: number;
    defaultPrice: number;
    multiplier: number;
    description: string;
}

export const INSTRUMENTS: Record<string, InstrumentMeta> = {
    'GC Dec27': {
        symbol: 'GC Dec27',
        name: 'Gold Futures',
        exchange: 'COMEX',
        tickSize: 0.1,
        decimals: 2,
        defaultPrice: 2641.5,
        multiplier: 100,
        description: 'COMEX Gold Futures 100oz',
    },
    'CL Dec27': {
        symbol: 'CL Dec27',
        name: 'Crude Oil',
        exchange: 'NYMEX',
        tickSize: 0.01,
        decimals: 2,
        defaultPrice: 75.4,
        multiplier: 1000,
        description: 'NYMEX Light Sweet Crude 1,000 bbl',
    },
    'SR3 Dec27': {
        symbol: 'SR3 Dec27',
        name: 'SOFR 3M',
        exchange: 'CME',
        tickSize: 0.005,
        decimals: 3,
        defaultPrice: 95.5,
        multiplier: 2500,
        description: 'CME 3-Month SOFR Index Futures',
    },
    'CRA Dec27': {
        symbol: 'CRA Dec27',
        name: 'CORRA 3M',
        exchange: 'MX',
        tickSize: 0.005,
        decimals: 3,
        defaultPrice: 96.0,
        multiplier: 2500,
        description: 'Montreal Exchange 3-Month CORRA Futures',
    },
    'ER3 Jun26': {
        symbol: 'ER3 Jun26',
        name: 'ESTR 3M',
        exchange: 'ICE',
        tickSize: 0.005,
        decimals: 3,
        defaultPrice: 97.0,
        multiplier: 2500,
        description: 'ICE Futures 3-Month ESTR Futures',
    },
};

export const INSTRUMENT_SYMBOLS = Object.keys(INSTRUMENTS);
export const DEFAULT_INSTRUMENT = 'GC Dec27';