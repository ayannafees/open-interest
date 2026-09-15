import React from 'react';
import { INSTRUMENTS, INSTRUMENT_SYMBOLS } from '../constants/instruments';
import type { Position } from '../types/order';
import type { PriceTicker } from '../types/instrument';

interface PositionBookWidgetProps {
    positions: Position[];
    tickers: Record<string, PriceTicker>;
    onFlatten: (symbol: string, currentNetPos: number) => void;
}

export const PositionBookWidget: React.FC<PositionBookWidgetProps> = ({
    positions,
    tickers,
    onFlatten,
}) => {
    const positionMap: Record<string, Position> = {};
    positions.forEach((p) => {
        positionMap[p.instrument] = p;
    });

    let totalRealized = 0;
    let totalUnrealized = 0;

    INSTRUMENT_SYMBOLS.forEach((sym) => {
        const p = positionMap[sym];
        const ticker = tickers[sym];
        const cfg = INSTRUMENTS[sym];
        const lastPx = ticker?.last || cfg.defaultPrice;

        if (p) {
            totalRealized += p.realizedPl || 0;
            if (p.netPos !== 0 && p.avgPx > 0) {
                totalUnrealized += p.netPos * (lastPx - p.avgPx) * cfg.multiplier;
            }
        }
    });

    const totalCombined = totalRealized + totalUnrealized;

    return (
        <div className="w-full h-full flex flex-col gap-2.5 text-xs font-mono select-none">
            {/* Portfolio Totals Summary Strip */}
            <div className="flex items-center justify-between bg-[#e2e6eb] p-2 rounded border border-[#b4bcc8] shrink-0 shadow-sm">
                <div>
                    <span className="text-slate-600 text-[9px] uppercase font-bold block">Realized P&L</span>
                    <span
                        className={`font-black ${totalRealized > 0
                            ? 'text-blue-800'
                            : totalRealized < 0
                                ? 'text-red-800'
                                : 'text-slate-600'
                            }`}
                    >
                        {totalRealized >= 0 ? `+$${totalRealized.toFixed(2)}` : `-$${Math.abs(totalRealized).toFixed(2)}`}
                    </span>
                </div>

                <div className="border-l border-[#b4bcc8] pl-3">
                    <span className="text-slate-600 text-[9px] uppercase font-bold block">Unrealized P&L</span>
                    <span
                        className={`font-black ${totalUnrealized > 0
                            ? 'text-blue-800'
                            : totalUnrealized < 0
                                ? 'text-red-800'
                                : 'text-slate-600'
                            }`}
                    >
                        {totalUnrealized >= 0 ? `+$${totalUnrealized.toFixed(2)}` : `-$${Math.abs(totalUnrealized).toFixed(2)}`}
                    </span>
                </div>

                <div className="border-l border-[#b4bcc8] pl-3">
                    <span className="text-slate-600 text-[9px] uppercase font-bold block">Net Combined</span>
                    <span
                        className={`font-black ${totalCombined > 0
                            ? 'text-blue-800'
                            : totalCombined < 0
                                ? 'text-red-800'
                                : 'text-slate-600'
                            }`}
                    >
                        {totalCombined >= 0 ? `+$${totalCombined.toFixed(2)}` : `-$${Math.abs(totalCombined).toFixed(2)}`}
                    </span>
                </div>
            </div>

            {/* Position Table */}
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto border border-[#b4bcc8] rounded bg-white shadow-inner">
                <table className="w-full text-left text-xs border-collapse">
                    <thead className="sticky top-0 bg-[#eef1f6] border-b border-[#b4bcc8] z-10 shadow-sm">
                        <tr className="text-[9px] text-slate-700 uppercase font-extrabold">
                            <th className="py-1.5 px-2">Contract</th>
                            <th className="py-1.5 px-2">Net Pos</th>
                            <th className="py-1.5 px-2">Avg Entry</th>
                            <th className="py-1.5 px-2">Last Px</th>
                            <th className="py-1.5 px-2 text-right">Realized</th>
                            <th className="py-1.5 px-2 text-right">Unrealized</th>
                            <th className="py-1.5 px-2 text-right">Total</th>
                            <th className="py-1.5 px-2 text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[#cbd5e1]">
                        {INSTRUMENT_SYMBOLS.map((sym) => {
                            const p = positionMap[sym] || { netPos: 0, buyQty: 0, sellQty: 0, avgPx: 0, realizedPl: 0 };
                            const ticker = tickers[sym];
                            const cfg = INSTRUMENTS[sym];
                            const lastPx = ticker?.last || cfg.defaultPrice;
                            const uPnL =
                                p.netPos !== 0 && p.avgPx > 0
                                    ? p.netPos * (lastPx - p.avgPx) * cfg.multiplier
                                    : 0;
                            const totalPnL = (p.realizedPl || 0) + uPnL;

                            return (
                                <tr key={sym} className="hover:bg-slate-50 transition">
                                    <td className="py-1.5 px-2 font-bold text-slate-900">{sym}</td>
                                    <td className="py-1.5 px-2">
                                        <span
                                            className={`font-black px-1.5 py-0.5 rounded text-[10px] ${p.netPos > 0
                                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                                : p.netPos < 0
                                                    ? 'bg-red-100 text-red-800 border border-red-300'
                                                    : 'bg-slate-100 text-slate-600'
                                                }`}
                                        >
                                            {p.netPos > 0 ? `+${p.netPos} L` : p.netPos < 0 ? `${p.netPos} S` : '0 FLAT'}
                                        </span>
                                    </td>
                                    <td className="py-1.5 px-2 font-semibold text-slate-800">
                                        {p.avgPx > 0 ? p.avgPx.toFixed(cfg.decimals) : '—'}
                                    </td>
                                    <td className="py-1.5 px-2 font-semibold text-slate-600">
                                        {lastPx.toFixed(cfg.decimals)}
                                    </td>
                                    <td className="py-1.5 px-2 font-bold text-right">
                                        <span
                                            className={
                                                p.realizedPl > 0
                                                    ? 'text-blue-800'
                                                    : p.realizedPl < 0
                                                        ? 'text-red-800'
                                                        : 'text-slate-500'
                                            }
                                        >
                                            ${(p.realizedPl || 0).toFixed(2)}
                                        </span>
                                    </td>
                                    <td className="py-1.5 px-2 font-bold text-right">
                                        <span
                                            className={
                                                uPnL > 0 ? 'text-blue-800' : uPnL < 0 ? 'text-red-800' : 'text-slate-500'
                                            }
                                        >
                                            ${uPnL.toFixed(2)}
                                        </span>
                                    </td>
                                    <td className="py-1.5 px-2 font-black text-right">
                                        <span
                                            className={
                                                totalPnL > 0
                                                    ? 'text-emerald-700'
                                                    : totalPnL < 0
                                                        ? 'text-red-700'
                                                        : 'text-slate-500'
                                            }
                                        >
                                            ${totalPnL.toFixed(2)}
                                        </span>
                                    </td>
                                    <td className="py-1.5 px-2 text-right">
                                        {p.netPos !== 0 ? (
                                            <button
                                                type="button"
                                                onClick={() => onFlatten(sym, p.netPos)}
                                                className="px-2 py-0.5 bg-amber-100 hover:bg-amber-200 text-amber-900 text-[10px] font-bold rounded border border-amber-300 transition active:scale-95 shadow-sm"
                                            >
                                                Flatten
                                            </button>
                                        ) : (
                                            <span className="text-[9px] text-slate-400 italic">Flat</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};