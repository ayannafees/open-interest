import React, { useState, useMemo } from 'react';
import { INSTRUMENTS } from '../constants/instruments';
import type { Fill } from '../types/order';

interface TimeAndSalesWidgetProps {
    instrument: string;
    trades: Fill[];
}

function formatTradeTime(isoString: string): string {
    try {
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return isoString;
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    } catch {
        return isoString;
    }
}

export const TimeAndSalesWidget: React.FC<TimeAndSalesWidgetProps> = ({ instrument, trades }) => {
    const [minSize, setMinSize] = useState<number>(1);
    const config = INSTRUMENTS[instrument];

    const sortedTrades = useMemo(() => {
        const raw = Array.isArray(trades) ? trades : [];
        return raw
            .filter((t) => (instrument ? t.instrument === instrument : true))
            .filter((t) => t.qty >= minSize)
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
            .slice(0, 200);
    }, [trades, instrument, minSize]);

    return (
        <div className="w-full h-full min-h-0 flex flex-col gap-2 text-xs font-mono select-none overflow-hidden">
            {/* Tape Filter Header */}
            <div className="bg-[#e2e6eb] p-1.5 rounded border border-[#b4bcc8] flex items-center justify-between gap-2 shrink-0 shadow-sm">
                <span className="text-[10px] text-slate-700 uppercase font-black">
                    {sortedTrades.length} Matches Recorded
                </span>

                <div className="flex items-center gap-1.5 bg-white border border-[#b4bcc8] rounded px-2 py-0.5 shadow-sm">
                    <span className="text-[10px] text-slate-600 font-bold">Min Qty:</span>
                    <select
                        value={minSize}
                        onChange={(e) => setMinSize(parseInt(e.target.value, 10))}
                        className="bg-transparent text-[10px] font-bold text-slate-900 outline-none cursor-pointer"
                    >
                        <option value="1">All Sizes (≥ 1)</option>
                        <option value="5">≥ 5 Lots</option>
                        <option value="10">≥ 10 Lots</option>
                        <option value="25">≥ 25 Lots</option>
                    </select>
                </div>
            </div>

            {/* Tape Row Stream (Newest at Top) */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1 border border-[#b4bcc8] rounded bg-white p-1 shadow-inner">
                {sortedTrades.length === 0 ? (
                    <div className="text-slate-500 text-center py-12 text-[11px]">
                        Waiting for executed trade matches...
                    </div>
                ) : (
                    sortedTrades.map((t, idx) => {
                        const rawSide = t.side || t.aggressorSide || (t as any).aggressor_side || 'BUY';
                        const isBuy = String(rawSide).toUpperCase() === 'BUY';

                        return (
                            <div
                                key={t.id || `${t.time}_${t.instrument}_${t.price}_${idx}`}
                                className="p-1.5 bg-white hover:bg-slate-50 border border-slate-200 rounded flex items-center justify-between text-[11px] transition shadow-sm"
                            >
                                <span className="text-[10px] text-slate-500 font-mono" title={t.time}>
                                    {formatTradeTime(t.time)}
                                </span>
                                <span className="font-bold text-slate-900">{t.instrument}</span>
                                <span
                                    className={`font-black ${isBuy ? 'text-blue-700' : 'text-red-700'}`}
                                >
                                    {t.qty} @ {typeof t.price === 'number' ? t.price.toFixed(config?.decimals || 2) : t.price}
                                </span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};