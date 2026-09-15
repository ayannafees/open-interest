import React, { useState, useMemo, useEffect } from 'react';
import { INSTRUMENTS, INSTRUMENT_SYMBOLS } from '../constants/instruments';
import type { Fill, Order } from '../types/order';

interface FillBookWidgetProps {
    fills?: Fill[];
    orders?: Order[];
    traderId?: string | null;
}

export const FillBookWidget: React.FC<FillBookWidgetProps> = ({ fills: propFills, orders, traderId }) => {
    const [selectedSymbol, setSelectedSymbol] = useState<string>('ALL');
    const [persistedFills, setPersistedFills] = useState<Fill[]>(() => {
        try {
            const key = traderId ? `oi_trader_fills_${traderId}` : 'oi_trader_fills_default';
            const saved = localStorage.getItem(key);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch {}
        return [];
    });

    useEffect(() => {
        if (traderId) {
            try {
                const saved = localStorage.getItem(`oi_trader_fills_${traderId}`);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed)) {
                        setPersistedFills(parsed);
                        return;
                    }
                }
            } catch {}
            setPersistedFills([]);
        }
    }, [traderId]);

    useEffect(() => {
        if (propFills !== undefined) {
            setPersistedFills(propFills);
            if (traderId && propFills.length > 0) {
                try {
                    localStorage.setItem(`oi_trader_fills_${traderId}`, JSON.stringify(propFills));
                } catch {}
            }
        }
    }, [propFills, traderId]);

    const sourceFills = useMemo(() => {
        if (propFills && propFills.length > 0) {
            return propFills;
        }
        if (persistedFills && persistedFills.length > 0) {
            return persistedFills;
        }
        if (orders && orders.length > 0) {
            return orders
                .filter((o) => o.status === 'FILLED' || (o.filledQty && o.filledQty > 0))
                .map((o) => ({
                    id: o.id,
                    instrument: o.instrument,
                    side: o.side,
                    price: o.price,
                    qty: o.filledQty || o.qty,
                    time: o.updatedAt || o.createdAt,
                } as Fill));
        }
        return [];
    }, [propFills, persistedFills, orders]);

    const myFills = useMemo(() => {
        let list = [...sourceFills];

        if (selectedSymbol !== 'ALL') {
            list = list.filter((f) => f.instrument === selectedSymbol);
        }

        // Sort latest -> oldest
        list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

        return list;
    }, [sourceFills, selectedSymbol]);

    const totalLots = myFills.reduce((sum, f) => sum + f.qty, 0);

    return (
        <div className="w-full h-full min-h-0 flex flex-col gap-2 text-xs font-mono select-none overflow-hidden">
            {/* Filter & Metric Strip */}
            <div className="bg-[#e2e6eb] p-2 rounded border border-[#b4bcc8] flex flex-wrap items-center justify-between gap-2 shrink-0 shadow-sm">
                <div className="flex items-center gap-3">
                    <span className="text-[10px] text-slate-700 uppercase font-black">
                        {myFills.length} Fills Executed
                    </span>
                    <div className="hidden sm:flex items-center gap-2 text-[10px] pl-2 border-l border-[#b4bcc8] text-slate-600">
                        <span>
                            Lots: <strong className="text-slate-900 font-bold">{totalLots}</strong>
                        </span>
                    </div>
                </div>

                <select
                    value={selectedSymbol}
                    onChange={(e) => setSelectedSymbol(e.target.value)}
                    className="bg-white border border-[#b4bcc8] rounded px-2 py-0.5 text-[10px] font-bold text-slate-800 outline-none cursor-pointer shadow-sm"
                >
                    <option value="ALL">All Contracts</option>
                    {INSTRUMENT_SYMBOLS.map((sym) => (
                        <option key={sym} value={sym}>
                            {sym}
                        </option>
                    ))}
                </select>
            </div>

            {/* Fills List Blotter */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 border border-[#b4bcc8] rounded bg-white p-1 shadow-inner">
                {myFills.length === 0 ? (
                    <div className="text-slate-500 text-center py-12 text-[11px]">
                        No executions found. Submit orders to generate fills.
                    </div>
                ) : (
                    myFills.map((f, idx) => {
                        const rawSide = f.side || (f as any).userSide || (f as any).user_side || 'BUY';
                        const isBuy = String(rawSide).toUpperCase() === 'BUY';
                        const decimals = INSTRUMENTS[f.instrument]?.decimals || 2;

                        return (
                            <div
                                key={f.id || idx}
                                className="p-2 bg-white hover:bg-slate-50 border border-slate-200 rounded flex items-center justify-between text-xs transition shadow-sm"
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-[9px] text-slate-500 font-mono" title={f.time}>
                                        {new Date(f.time).toLocaleTimeString()}
                                    </span>
                                    <span className="font-bold text-slate-900">{f.instrument}</span>
                                    <span
                                        className={`font-black px-1.5 py-0.5 rounded text-[10px] ${isBuy
                                            ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                            : 'bg-red-100 text-red-800 border border-red-300'
                                            }`}
                                    >
                                        {isBuy ? 'BUY' : 'SELL'} {f.qty}
                                    </span>
                                    <span className="font-semibold text-slate-900">
                                        @{typeof f.price === 'number' ? f.price.toFixed(decimals) : f.price}
                                    </span>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};