import React, { useState, useEffect, useMemo } from 'react';
import { INSTRUMENTS } from '../constants/instruments';
import type { Order, OrderSide, OrderType, OrderTIF, PIQData, Fill } from '../types/order';
import type { DepthBook, PriceTicker } from '../types/instrument';

interface OrderTicketWidgetProps {
    instrument: string;
    ticker?: PriceTicker;
    depth?: DepthBook;
    orders: Order[];
    recentTrades?: Fill[];
    piqMap: Record<string, PIQData>;
    onPlaceOrder: (order: {
        instrument: string;
        side: OrderSide;
        type: OrderType;
        price: number;
        qty: number;
        tif: OrderTIF;
    }) => void;
    onCancelOrder: (orderId: string, instrument: string) => void;
    onCancelAll: (instrument: string) => void;
}

/**
 * Real-time PIQ Resolver: Uses server telemetry if available,
 * falling back instantly to live L2 depth & FIFO queue blotter estimation.
 */
function getOrderPIQ(
    order: Order,
    allOrders: Order[],
    piqMap: Record<string, PIQData>,
    depth?: DepthBook,
    ticker?: PriceTicker
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

export const OrderTicketWidget: React.FC<OrderTicketWidgetProps> = ({
    instrument,
    ticker,
    depth,
    orders,
    recentTrades = [],
    piqMap,
    onPlaceOrder,
    onCancelOrder,
    onCancelAll,
}) => {
    const config = INSTRUMENTS[instrument] || {
        name: instrument,
        tickSize: 0.1,
        decimals: 2,
        defaultPrice: 2640.0,
        multiplier: 100,
    };

    const [qty, setQty] = useState<number>(10);
    const [price, setPrice] = useState<number>(config.defaultPrice);
    const [orderType, setOrderType] = useState<OrderType>('LIMIT');
    const [tif, setTif] = useState<OrderTIF>('DAY');

    const latestTrade = useMemo(() => {
        return (recentTrades || []).find((t) => t.instrument === instrument);
    }, [recentTrades, instrument]);

    const latestPrice = latestTrade?.price ?? ticker?.last;
    const latestQty = latestTrade?.qty ?? ticker?.lastQty;

    useEffect(() => {
        if (ticker?.bid && ticker.bid > 0) {
            setPrice(Number(ticker.bid.toFixed(config.decimals)));
        } else if (latestPrice && latestPrice > 0) {
            setPrice(Number(latestPrice.toFixed(config.decimals)));
        } else {
            setPrice(config.defaultPrice);
        }
    }, [instrument]);

    const adjustPrice = (ticks: number) => {
        setPrice((prev) => {
            const next = prev + ticks * config.tickSize;
            return Number(next.toFixed(config.decimals));
        });
    };

    const handleExecute = (side: OrderSide) => {
        const targetPrice =
            orderType === 'MARKET'
                ? side === 'BUY'
                    ? ticker?.ask || price
                    : ticker?.bid || price
                : price;

        onPlaceOrder({
            instrument,
            side,
            type: orderType,
            price: Number(targetPrice.toFixed(config.decimals)),
            qty,
            tif,
        });
    };

    const instrumentOrders = orders.filter((o) => o.instrument === instrument);
    const workingCount = instrumentOrders.filter(
        (o) => o.status === 'WORKING' || o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED'
    ).length;

    return (
        <div className="w-full h-full flex flex-col gap-3 text-xs overflow-y-auto pr-1 select-none font-mono">
            {/* Inside Market Bar with Real-Time LTP & LTQ */}
            <div className="grid grid-cols-4 gap-1.5 text-center bg-[#e2e6eb] p-2 rounded border border-[#b4bcc8] shrink-0 shadow-sm">
                <div
                    onClick={() => ticker?.bid && setPrice(Number(ticker.bid.toFixed(config.decimals)))}
                    className="cursor-pointer bg-[#edf2f8] hover:bg-blue-100/80 border border-blue-200 p-1 rounded transition shadow-sm"
                    title="Click to copy Bid Price"
                >
                    <div className="text-[9px] text-slate-600 uppercase font-bold">Bid</div>
                    <div className="text-xs font-black text-blue-700">
                        {ticker?.bid ? ticker.bid.toFixed(config.decimals) : '—'}
                    </div>
                </div>

                <div
                    onClick={() => latestPrice && setPrice(Number(latestPrice.toFixed(config.decimals)))}
                    className="cursor-pointer bg-white hover:bg-slate-50 border border-[#b4bcc8] p-1 rounded transition shadow-sm"
                    title="Click to copy Last Price"
                >
                    <div className="text-[9px] text-slate-600 uppercase font-bold">Last</div>
                    <div className="text-sm font-black text-slate-900">
                        {latestPrice ? latestPrice.toFixed(config.decimals) : '—'}
                    </div>
                </div>

                <div
                    className="p-1 rounded bg-[#f8fafc] border border-[#b4bcc8] flex flex-col justify-center select-none shadow-sm"
                    title="Last Traded Quantity (LTQ)"
                >
                    <div className="text-[9px] text-slate-600 uppercase font-bold">LTQ</div>
                    <div className="text-xs font-black text-emerald-700">
                        {latestQty !== undefined ? latestQty : '—'}
                    </div>
                </div>

                <div
                    onClick={() => ticker?.ask && setPrice(Number(ticker.ask.toFixed(config.decimals)))}
                    className="cursor-pointer bg-[#fcf2f2] hover:bg-red-100/80 border border-red-200 p-1 rounded transition shadow-sm"
                    title="Click to copy Ask Price"
                >
                    <div className="text-[9px] text-slate-600 uppercase font-bold">Ask</div>
                    <div className="text-xs font-black text-red-700">
                        {ticker?.ask ? ticker.ask.toFixed(config.decimals) : '—'}
                    </div>
                </div>
            </div>

            {/* Lot Controls */}
            <div className="bg-[#eef1f6] p-2.5 rounded border border-[#b4bcc8] space-y-2 shrink-0 shadow-sm">
                <div className="flex justify-between items-center text-xs font-semibold">
                    <span className="text-slate-600 text-[10px] uppercase font-bold">Lots (Qty):</span>
                    <span className="text-blue-800 font-black">{qty} Lots</span>
                </div>

                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setQty((q) => Math.max(1, q - 5))}
                        className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                    >
                        -5
                    </button>
                    <button
                        type="button"
                        onClick={() => setQty((q) => Math.max(1, q - 1))}
                        className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                    >
                        -1
                    </button>
                    <input
                        type="number"
                        min="1"
                        max="1000"
                        value={qty}
                        onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                        className="flex-1 bg-white border border-[#b4bcc8] rounded px-2 py-1 text-center font-bold text-slate-900 text-sm outline-none focus:border-blue-600 shadow-inner"
                    />
                    <button
                        type="button"
                        onClick={() => setQty((q) => q + 1)}
                        className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                    >
                        +1
                    </button>
                    <button
                        type="button"
                        onClick={() => setQty((q) => q + 5)}
                        className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                    >
                        +5
                    </button>
                </div>

                <div className="grid grid-cols-6 gap-1">
                    {[1, 5, 10, 25, 50, 100].map((preset) => (
                        <button
                            key={preset}
                            type="button"
                            onClick={() => setQty(preset)}
                            className={`py-0.5 text-[10px] font-bold rounded border transition ${qty === preset
                                ? 'bg-slate-800 text-white border-slate-900 shadow-sm'
                                : 'bg-white hover:bg-slate-100 text-slate-700 border-[#b4bcc8]'
                                }`}
                        >
                            {preset}
                        </button>
                    ))}
                </div>
            </div>

            {/* Type & TIF */}
            <div className="grid grid-cols-2 gap-2 shrink-0">
                <div>
                    <label className="text-[9px] text-slate-600 uppercase block font-bold mb-1">
                        Type:
                    </label>
                    <div className="grid grid-cols-2 gap-1 bg-[#e2e6eb] p-0.5 rounded border border-[#b4bcc8]">
                        <button
                            type="button"
                            onClick={() => setOrderType('LIMIT')}
                            className={`py-1 text-[10px] font-bold rounded transition ${orderType === 'LIMIT'
                                ? 'bg-white text-slate-900 shadow-sm border border-[#b4bcc8]'
                                : 'text-slate-600 hover:text-slate-900'
                                }`}
                        >
                            LIMIT
                        </button>
                        <button
                            type="button"
                            onClick={() => setOrderType('MARKET')}
                            className={`py-1 text-[10px] font-bold rounded transition ${orderType === 'MARKET'
                                ? 'bg-white text-slate-900 shadow-sm border border-[#b4bcc8]'
                                : 'text-slate-600 hover:text-slate-900'
                                }`}
                        >
                            MKT
                        </button>
                    </div>
                </div>

                <div>
                    <label className="text-[9px] text-slate-600 uppercase block font-bold mb-1">
                        TIF:
                    </label>
                    <select
                        value={tif}
                        onChange={(e) => setTif(e.target.value as OrderTIF)}
                        className="w-full bg-white border border-[#b4bcc8] rounded px-2 py-1 text-xs font-bold text-slate-900 outline-none shadow-sm cursor-pointer"
                    >
                        <option value="DAY">DAY</option>
                        <option value="GTC">GTC</option>
                        <option value="IOC">IOC</option>
                        <option value="FOK">FOK</option>
                    </select>
                </div>
            </div>

            {/* Price Controls (if LIMIT) */}
            {orderType === 'LIMIT' && (
                <div className="space-y-1.5 shrink-0 bg-[#eef1f6] p-2 rounded border border-[#b4bcc8] shadow-sm">
                    <div className="flex justify-between items-center text-xs font-semibold">
                        <span className="text-slate-600 text-[10px] uppercase font-bold">Limit Price:</span>
                        <div className="flex gap-1 text-[9px]">
                            <button
                                type="button"
                                onClick={() => ticker?.bid && setPrice(Number(ticker.bid.toFixed(config.decimals)))}
                                className="px-1.5 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-800 rounded border border-blue-200 font-bold shadow-sm"
                            >
                                Bid
                            </button>
                            <button
                                type="button"
                                onClick={() => latestPrice && setPrice(Number(latestPrice.toFixed(config.decimals)))}
                                className="px-1.5 py-0.5 bg-white hover:bg-slate-100 text-slate-800 rounded border border-[#b4bcc8] font-bold shadow-sm"
                            >
                                Last
                            </button>
                            <button
                                type="button"
                                onClick={() => ticker?.ask && setPrice(Number(ticker.ask.toFixed(config.decimals)))}
                                className="px-1.5 py-0.5 bg-red-50 hover:bg-red-100 text-red-800 rounded border border-red-200 font-bold shadow-sm"
                            >
                                Ask
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => adjustPrice(-5)}
                            className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                        >
                            -5T
                        </button>
                        <button
                            type="button"
                            onClick={() => adjustPrice(-1)}
                            className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                        >
                            -1T
                        </button>
                        <input
                            type="number"
                            step={config.tickSize}
                            value={price}
                            onChange={(e) => setPrice(parseFloat(e.target.value) || 0)}
                            className="flex-1 bg-white border border-[#b4bcc8] rounded px-2 py-1 text-center font-black text-slate-900 text-sm outline-none focus:border-blue-600 shadow-inner"
                        />
                        <button
                            type="button"
                            onClick={() => adjustPrice(1)}
                            className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                        >
                            +1T
                        </button>
                        <button
                            type="button"
                            onClick={() => adjustPrice(5)}
                            className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] shadow-sm active:scale-95"
                        >
                            +5T
                        </button>
                    </div>
                </div>
            )}

            {/* Execution Buttons */}
            <div className="grid grid-cols-2 gap-2 shrink-0 pt-1">
                <button
                    type="button"
                    onClick={() => handleExecute('BUY')}
                    className="py-2.5 bg-[#1d70b8] hover:bg-[#155b96] text-white font-black text-xs rounded shadow transition active:scale-95 flex flex-col items-center justify-center border border-[#17568f]"
                >
                    <span>BUY {qty} LOTS</span>
                    <span className="text-[9px] text-blue-100 font-normal">
                        @ {orderType === 'LIMIT' ? price.toFixed(config.decimals) : 'MKT'}
                    </span>
                </button>

                <button
                    type="button"
                    onClick={() => handleExecute('SELL')}
                    className="py-2.5 bg-[#c53030] hover:bg-[#a82424] text-white font-black text-xs rounded shadow transition active:scale-95 flex flex-col items-center justify-center border border-[#9c2424]"
                >
                    <span>SELL {qty} LOTS</span>
                    <span className="text-[9px] text-red-100 font-normal">
                        @ {orderType === 'LIMIT' ? price.toFixed(config.decimals) : 'MKT'}
                    </span>
                </button>
            </div>

            {/* Working Orders Section with Instant PIQ */}
            <div className="flex flex-col pt-2 border-t border-[#b4bcc8]">
                <div className="text-[10px] text-slate-600 font-bold uppercase mb-1.5 flex items-center justify-between">
                    <span>Working Orders ({workingCount}):</span>
                    {workingCount > 0 && (
                        <button
                            type="button"
                            onClick={() => onCancelAll(instrument)}
                            className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white text-[9px] font-bold rounded border border-red-700 transition shadow-sm active:scale-95"
                        >
                            Cancel All
                        </button>
                    )}
                </div>

                <div className="space-y-1.5">
                    {instrumentOrders.length === 0 ? (
                        <div className="text-[11px] text-slate-500 text-center py-4 bg-white rounded border border-[#b4bcc8]">No active orders</div>
                    ) : (
                        instrumentOrders.map((o) => {
                            const isLive = o.status === 'WORKING' || o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED';
                            const piq = isLive ? getOrderPIQ(o, orders, piqMap, depth, ticker) : null;

                            return (
                                <div
                                    key={o.id}
                                    className="p-2 bg-white border border-[#b4bcc8] rounded flex flex-col gap-1 text-[11px] shadow-sm"
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5">
                                            <span className={`font-black ${o.side === 'BUY' ? 'text-blue-700' : 'text-red-700'}`}>
                                                {o.side} {o.qty}
                                            </span>
                                            <span className="font-semibold text-slate-900">@{o.price}</span>
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <span
                                                className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${o.status === 'WORKING'
                                                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                                                    : o.status === 'FILLED'
                                                        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                                        : 'bg-slate-100 text-slate-600 border-slate-300'
                                                    }`}
                                            >
                                                {o.status}
                                            </span>
                                            {isLive && (
                                                <button
                                                    onClick={() => onCancelOrder(o.id, o.instrument)}
                                                    className="px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white text-[9px] font-bold rounded shadow-sm active:scale-95"
                                                >
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {isLive && piq && (
                                        <div className="grid grid-cols-3 gap-1 text-[9px] text-center bg-slate-50 p-1 rounded border border-slate-200">
                                            <div>
                                                <span className="text-slate-500 block">Ahead:</span>
                                                <span className="font-bold text-blue-700">{piq.aheadQty} lots</span>
                                            </div>
                                            <div>
                                                <span className="text-slate-500 block">Behind:</span>
                                                <span className="font-bold text-slate-700">{piq.behindQty} lots</span>
                                            </div>
                                            <div>
                                                <span className="text-slate-500 block">Fill Prob:</span>
                                                <span className="font-bold text-blue-800">
                                                    {Math.round((piq.fillProbability || 0) * 100)}%
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};