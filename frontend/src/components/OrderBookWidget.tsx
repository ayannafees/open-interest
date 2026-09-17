import React, { useState } from 'react';
import {
    ClipboardList,
    Filter,
    XCircle,
    Search,
} from 'lucide-react';
import { INSTRUMENTS, INSTRUMENT_SYMBOLS } from '../constants/instruments';
import type { DepthBook, PriceTicker } from '../types/instrument';
import type { Order, PIQData } from '../types/order';

interface OrderBookWidgetProps {
    instrument: string;
    orders: Order[];
    piqMap: Record<string, PIQData>;
    depths?: Record<string, DepthBook>;
    tickers?: Record<string, PriceTicker>;
    onCancelOrder: (orderId: string, instrument: string) => void;
    onCancelAll: (instrument?: string) => void;
}

type StatusFilter = 'ACTIVE' | 'FILLED' | 'CANCELLED' | 'ALL';

/**
 * Real-time PIQ Resolver: Uses server telemetry if available,
 * falling back instantly to live L2 depth & FIFO queue blotter estimation.
 */
function getOrderPIQ(
    order: Order,
    allOrders: Order[],
    piqMap: Record<string, PIQData>,
    depths?: Record<string, DepthBook>,
    tickers?: Record<string, PriceTicker>
): PIQData {
    if (piqMap[order.id] && piqMap[order.id].fillProbability !== undefined) {
        return piqMap[order.id];
    }

    const config = INSTRUMENTS[order.instrument] || {
        name: order.instrument,
        tickSize: 0.1,
        decimals: 2,
        defaultPrice: 2650,
        multiplier: 100,
    };
    const tickSize = config.tickSize || 0.1;
    const ticker = tickers?.[order.instrument];
    const depth = depths?.[order.instrument];

    const orderPrice = typeof order.price === 'number' ? order.price : parseFloat(order.price) || 0;
    const orderQty = order.remainingQty !== undefined ? order.remainingQty : order.qty;

    const bestBid = ticker?.bid || depth?.bids?.[0]?.price || orderPrice;
    const bestAsk = ticker?.ask || depth?.asks?.[0]?.price || orderPrice;

    // 1. Find all active sibling orders at the exact same price level & side (FIFO ordering)
    const orderTime = new Date(order.createdAt || order.updatedAt || 0).getTime();
    let siblingAheadQty = 0;
    let siblingBehindQty = 0;

    allOrders.forEach((o) => {
        if (
            o.id !== order.id &&
            o.instrument === order.instrument &&
            o.side === order.side &&
            (o.status === 'WORKING' || o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED')
        ) {
            const p = typeof o.price === 'number' ? o.price : parseFloat(o.price) || 0;
            if (Math.abs(p - orderPrice) < tickSize * 0.4) {
                const oTime = new Date(o.createdAt || o.updatedAt || 0).getTime();
                const oQty = o.remainingQty !== undefined ? o.remainingQty : o.qty;
                if (oTime < orderTime || (oTime === orderTime && o.id < order.id)) {
                    siblingAheadQty += oQty;
                } else {
                    siblingBehindQty += oQty;
                }
            }
        }
    });

    let depthLevelQty = 0;
    let deltaTicks = 0;

    if (order.side === 'BUY') {
        deltaTicks = Math.max(0, Math.round((bestBid - orderPrice) / tickSize));
        if (depth?.bids && depth.bids.length > 0) {
            const level = depth.bids.find((b) => Math.abs(b.price - orderPrice) < tickSize * 0.4);
            if (level) {
                depthLevelQty = level.qty || level.size || 0;
            }
        }
    } else {
        deltaTicks = Math.max(0, Math.round((orderPrice - bestAsk) / tickSize));
        if (depth?.asks && depth.asks.length > 0) {
            const level = depth.asks.find((a) => Math.abs(a.price - orderPrice) < tickSize * 0.4);
            if (level) {
                depthLevelQty = level.qty || level.size || 0;
            }
        }
    }

    const totalTraderLevelQty = siblingAheadQty + orderQty + siblingBehindQty;
    const totalLevelQty = Math.max(depthLevelQty, totalTraderLevelQty);
    const aheadQty = siblingAheadQty;
    const behindQty = Math.max(siblingBehindQty, totalLevelQty - aheadQty - orderQty);

    const queueRatio = totalLevelQty > 0 ? aheadQty / totalLevelQty : 0;
    const baseProb = Math.max(0.05, 1.0 - 0.65 * queueRatio);
    const distanceDecay = Math.exp(-0.25 * deltaTicks);
    const fillProbability = Number((baseProb * distanceDecay).toFixed(4));

    return {
        orderId: order.id,
        instrument: order.instrument,
        side: order.side,
        price: orderPrice,
        queueRank: aheadQty + 1,
        aheadQty,
        behindQty,
        totalLevelQty,
        deltaTicks,
        fillProbability,
        timestamp: new Date().toISOString(),
    };
}

export const OrderBookWidget: React.FC<OrderBookWidgetProps> = ({
    instrument,
    orders,
    piqMap,
    depths,
    tickers,
    onCancelOrder,
    onCancelAll,
}) => {
    const [selectedSymbol, setSelectedSymbol] = useState<string>(instrument || 'ALL');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
    const [searchQuery, setSearchQuery] = useState<string>('');

    // 1. Filter Orders
    const filteredOrders = orders.filter((o) => {
        // Contract filter
        if (selectedSymbol !== 'ALL' && o.instrument !== selectedSymbol) {
            return false;
        }

        // Status filter
        if (statusFilter === 'ACTIVE') {
            if (o.status !== 'WORKING' && o.status !== 'SUBMITTED' && o.status !== 'PARTIALLY_FILLED' && o.status !== 'CANCELLING') {
                return false;
            }
        } else if (statusFilter === 'FILLED') {
            if (o.status !== 'FILLED') return false;
        } else if (statusFilter === 'CANCELLED') {
            if (o.status !== 'CANCELLED' && o.status !== 'REJECTED') return false;
        }

        // Search query
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            return (
                o.id.toLowerCase().includes(q) ||
                o.instrument.toLowerCase().includes(q) ||
                o.side.toLowerCase().includes(q) ||
                (o.status && o.status.toLowerCase().includes(q))
            );
        }

        return true;
    });

    // 2. Working Orders Metrics
    const activeOrders = orders.filter(
        (o) =>
            (selectedSymbol === 'ALL' || o.instrument === selectedSymbol) &&
            (o.status === 'WORKING' || o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED')
    );

    const totalWorkingLots = activeOrders.reduce(
        (sum, o) => sum + (o.remainingQty !== undefined ? o.remainingQty : o.qty),
        0
    );

    let totalWorkingNotional = 0;
    activeOrders.forEach((o) => {
        const mult = INSTRUMENTS[o.instrument]?.multiplier || 1;
        const qty = o.remainingQty !== undefined ? o.remainingQty : o.qty;
        totalWorkingNotional += qty * (o.price || 0) * mult;
    });

    return (
        <div className="w-full h-full min-h-0 flex flex-col gap-2 text-xs font-mono select-none overflow-hidden">
            {/* 1. Top Summary Strip & Bulk Actions */}
            <div className="bg-[#e2e6eb] p-2 rounded border border-[#b4bcc8] flex flex-wrap items-center justify-between gap-2 shrink-0 shadow-sm">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                        <ClipboardList size={14} className="text-blue-700" />
                        <span className="text-[11px] font-black text-slate-900 uppercase">
                            Order Book
                        </span>
                    </div>

                    <div className="flex items-center gap-2 text-[10px] pl-3 border-l border-[#b4bcc8]">
                        <div>
                            <span className="text-slate-600 uppercase mr-1">Active:</span>
                            <span className="font-bold text-amber-800 bg-amber-100 px-1.5 py-0.2 rounded border border-amber-300">{activeOrders.length} Orders</span>
                        </div>
                        <div>
                            <span className="text-slate-600 uppercase mr-1">Lots:</span>
                            <span className="font-bold text-slate-900">{totalWorkingLots} Lots</span>
                        </div>
                        <div>
                            <span className="text-slate-600 uppercase mr-1">Notional:</span>
                            <span className="font-bold text-blue-800">
                                ${totalWorkingNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                        </div>
                    </div>
                </div>

                {activeOrders.length > 0 && (
                    <button
                        onClick={() => onCancelAll(selectedSymbol === 'ALL' ? undefined : selectedSymbol)}
                        className="flex items-center gap-1 px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold rounded border border-red-700 transition active:scale-95 shadow-sm"
                    >
                        <XCircle size={11} />
                        <span>Cancel All ({activeOrders.length})</span>
                    </button>
                )}
            </div>

            {/* 2. Filter & Search Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-1 bg-[#e2e6eb] p-0.5 rounded border border-[#b4bcc8]">
                    {(['ACTIVE', 'FILLED', 'CANCELLED', 'ALL'] as const).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setStatusFilter(tab)}
                            className={`px-2 py-0.5 text-[10px] font-bold rounded transition ${statusFilter === tab
                                ? 'bg-white text-slate-900 shadow-sm border border-[#b4bcc8]'
                                : 'text-slate-600 hover:text-slate-900'
                                }`}
                        >
                            {tab === 'ACTIVE'
                                ? `Active (${activeOrders.length})`
                                : tab === 'FILLED'
                                    ? 'Filled'
                                    : tab === 'CANCELLED'
                                        ? 'Cancelled'
                                        : 'All History'}
                        </button>
                    ))}
                </div>

                <div className="flex items-center gap-2">
                    {/* Contract Selector Filter */}
                    <div className="flex items-center gap-1 bg-white border border-[#b4bcc8] rounded px-2 py-0.5 shadow-sm">
                        <Filter size={11} className="text-slate-500" />
                        <select
                            value={selectedSymbol}
                            onChange={(e) => setSelectedSymbol(e.target.value)}
                            className="bg-transparent text-[10px] font-bold text-slate-800 outline-none cursor-pointer"
                        >
                            <option value="ALL">All Contracts</option>
                            {INSTRUMENT_SYMBOLS.map((sym) => (
                                <option key={sym} value={sym}>
                                    {sym}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Search Box */}
                    <div className="flex items-center gap-1 bg-white border border-[#b4bcc8] rounded px-2 py-0.5 shadow-sm">
                        <Search size={11} className="text-slate-500" />
                        <input
                            type="text"
                            placeholder="Search ID..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="bg-transparent text-[10px] text-slate-800 placeholder-slate-400 outline-none w-20"
                        />
                    </div>
                </div>
            </div>

            {/* 3. Working Orders Table Blotter */}
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto border border-[#b4bcc8] rounded bg-white shadow-inner">
                <table className="w-full text-left text-xs border-collapse">
                    <thead className="sticky top-0 bg-[#eef1f6] border-b border-[#b4bcc8] z-10 shadow-sm">
                        <tr className="text-[9px] text-slate-700 uppercase font-extrabold">
                            <th className="py-1.5 px-2">Time</th>
                            <th className="py-1.5 px-2">Order ID</th>
                            <th className="py-1.5 px-2">Contract</th>
                            <th className="py-1.5 px-2">Side</th>
                            <th className="py-1.5 px-2">Type / TIF</th>
                            <th className="py-1.5 px-2">Price</th>
                            <th className="py-1.5 px-2">Lots (Fill/Total)</th>
                            <th className="py-1.5 px-2">PIQ Queue Rank (Ahead / Behind / Fill Prob)</th>
                            <th className="py-1.5 px-2">Status</th>
                            <th className="py-1.5 px-2 text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[#cbd5e1]">
                        {filteredOrders.length === 0 ? (
                            <tr>
                                <td colSpan={10} className="text-center py-12 text-slate-500 text-xs">
                                    {statusFilter === 'ACTIVE'
                                        ? 'No active working orders found. Submit an order from the DOM ladder or Order Ticket.'
                                        : 'No orders match the selected filter.'}
                                </td>
                            </tr>
                        ) : (
                            filteredOrders.map((o) => {
                                const isLive = o.status === 'WORKING' || o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED';
                                const piq = isLive ? getOrderPIQ(o, orders, piqMap, depths, tickers) : null;
                                const isBuy = o.side === 'BUY';
                                const dec = INSTRUMENTS[o.instrument]?.decimals || 2;
                                const fillProb = piq?.fillProbability !== undefined ? Math.round(piq.fillProbability * 100) : null;
                                const filledQty = o.filledQty || 0;
                                const totalQty = o.qty;

                                return (
                                    <tr key={o.id} className="hover:bg-slate-50 transition">
                                        {/* Timestamp */}
                                        <td className="py-2 px-2 text-[10px] text-slate-600 font-mono whitespace-nowrap">
                                            {new Date(o.createdAt || o.updatedAt).toLocaleTimeString()}
                                        </td>

                                        {/* Order ID */}
                                        <td className="py-2 px-2 font-mono text-[10px] text-slate-500 truncate max-w-[100px]" title={o.id}>
                                            {o.id}
                                        </td>

                                        {/* Contract */}
                                        <td className="py-2 px-2 font-bold text-slate-900 whitespace-nowrap">
                                            {o.instrument}
                                        </td>

                                        {/* Side */}
                                        <td className="py-2 px-2">
                                            <span
                                                className={`font-black px-1.5 py-0.5 rounded text-[10px] ${isBuy
                                                    ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                                    : 'bg-red-100 text-red-800 border border-red-300'
                                                    }`}
                                            >
                                                {o.side}
                                            </span>
                                        </td>

                                        {/* Type & TIF */}
                                        <td className="py-2 px-2 text-[10px] text-slate-600">
                                            <span className="font-semibold text-slate-800">
                                                {o.type && String(o.type) !== 'ORDER_EVENT' ? o.type : 'LIMIT'}
                                            </span>
                                            <span className="ml-1 text-slate-500">({o.tif || 'DAY'})</span>
                                        </td>

                                        {/* Limit Price */}
                                        <td className="py-2 px-2 font-black text-slate-900">
                                            {typeof o.price === 'number' ? o.price.toFixed(dec) : o.price || 'MKT'}
                                        </td>

                                        {/* Lots & Fill Progress */}
                                        <td className="py-2 px-2">
                                            <div className="flex flex-col gap-0.5">
                                                <span className="font-bold text-slate-900 text-[11px]">
                                                    {filledQty} / {totalQty} Lots
                                                </span>
                                                {totalQty > 0 && (
                                                    <div className="w-16 bg-slate-200 h-1.5 rounded-full overflow-hidden border border-slate-300">
                                                        <div
                                                            className="bg-emerald-600 h-full transition-all"
                                                            style={{ width: `${Math.round((filledQty / totalQty) * 100)}%` }}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        </td>

                                        {/* PIQ Telemetry Queue Rank */}
                                        <td className="py-2 px-2">
                                            {isLive && piq ? (
                                                <div className="flex items-center gap-1.5 text-[10px]">
                                                    <span className="font-bold text-blue-800 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200" title="Volume ahead in FIFO queue">
                                                        {piq.aheadQty} ahead
                                                    </span>
                                                    <span className="font-semibold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200" title="Volume behind you">
                                                        {piq.behindQty} behind
                                                    </span>
                                                    {fillProb !== null && (
                                                        <span
                                                            className={`font-black px-1.5 py-0.5 rounded border ${fillProb >= 70
                                                                ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                                                : fillProb >= 35
                                                                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                                                                    : 'bg-red-100 text-red-800 border-red-300'
                                                                }`}
                                                            title={`Fill Probability (ρ): ${fillProb}%`}
                                                        >
                                                            {fillProb}% Prob
                                                        </span>
                                                    )}
                                                    {piq.deltaTicks > 0 && (
                                                        <span className="text-[9px] text-slate-500" title={`Spread distance: ${piq.deltaTicks} ticks`}>
                                                            (+{piq.deltaTicks}T)
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-[10px] text-slate-400">—</span>
                                            )}
                                        </td>

                                        {/* Status Badge */}
                                        <td className="py-2 px-2">
                                            <span
                                                className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${o.status === 'WORKING'
                                                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                                                    : o.status === 'SUBMITTED'
                                                        ? 'bg-blue-100 text-blue-800 border-blue-300'
                                                        : o.status === 'PARTIALLY_FILLED'
                                                            ? 'bg-teal-100 text-teal-800 border-teal-300'
                                                            : o.status === 'FILLED'
                                                                ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                                                : o.status === 'CANCELLING'
                                                                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                                                                    : o.status === 'CANCELLED'
                                                                        ? 'bg-slate-100 text-slate-600 border-slate-300'
                                                                        : 'bg-red-100 text-red-800 border-red-300'
                                                    }`}
                                            >
                                                {o.status}
                                            </span>
                                        </td>

                                        {/* Action: Cancel */}
                                        <td className="py-2 px-2 text-right">
                                            {isLive && (
                                                <button
                                                    onClick={() => onCancelOrder(o.id, o.instrument)}
                                                    className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold rounded border border-red-700 transition active:scale-95 shadow-sm"
                                                    title="Cancel Order"
                                                >
                                                    Cancel
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};