import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Target, RotateCcw } from 'lucide-react';
import { INSTRUMENTS } from '../constants/instruments';
import type { DepthBook, PriceTicker } from '../types/instrument';
import type { Order, OrderSide, OrderType, OrderTIF, Fill } from '../types/order';

interface LadderWidgetProps {
    instrument: string;
    depth?: DepthBook;
    ticker?: PriceTicker;
    orders?: Order[];
    recentTrades?: Fill[];
    onPlaceOrder: (order: {
        instrument: string;
        side: OrderSide;
        type: OrderType;
        price: number;
        qty: number;
        tif: OrderTIF;
    }) => void;
    onCancelOrder?: (orderId: string, instrument: string) => void;
    onCancelAll?: (instrument: string) => void;
}

const ROW_HEIGHT = 28; // Strict 28px height per tick row
const TOTAL_LADDER_TICKS = 100; // Continuous range: 100 ticks above and below anchor (201 rows)

interface LadderRowProps {
    price: number;
    decimals: number;
    bidQty: number | undefined;
    askQty: number | undefined;
    workingQty: number | undefined;
    workingSide: 'BUY' | 'SELL' | undefined;
    workingOrderIds: string[] | undefined;
    isLtp: boolean;
    isHigh: boolean;
    isLow: boolean;
    isSpreadDivider: boolean;
    latestTradeQty: number | undefined;
    selectedLots: number;
    onBidClick: (price: number) => void;
    onAskClick: (price: number) => void;
    onCancelLevel: (orderIds: string[]) => void;
    onPointerDown: (e: React.PointerEvent | React.MouseEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
}

const LadderRow = React.memo<LadderRowProps>(({
    price,
    decimals,
    bidQty,
    askQty,
    workingQty,
    workingSide,
    workingOrderIds,
    isLtp,
    isHigh,
    isLow,
    isSpreadDivider,
    latestTradeQty,
    selectedLots,
    onBidClick,
    onAskClick,
    onCancelLevel,
    onPointerDown,
    onDoubleClick,
}) => {
    return (
        <div
            style={{ height: `${ROW_HEIGHT}px` }}
            className={`grid grid-cols-[36px_1fr_76px_1fr_36px] text-xs items-center relative ${isSpreadDivider ? 'border-b-2 border-black' : ''
                }`}
        >
            {/* 1. Working Orders Column */}
            <div
                onClick={() => workingOrderIds && onCancelLevel(workingOrderIds)}
                className="h-full flex items-center justify-center bg-[#e2e6ec] border-r border-[#cbd5e1] text-[10px] cursor-pointer hover:bg-red-100 transition"
            >
                {workingQty !== undefined && workingQty > 0 && (
                    <span
                        className={`px-1 py-0.2 rounded font-black text-[9px] ${workingSide === 'BUY' ? 'bg-[#1d70b8] text-white' : 'bg-[#c53030] text-white'
                            }`}
                        title="Click to cancel orders at this price"
                    >
                        {workingQty}
                    </span>
                )}
            </div>

            {/* 2. Bids Column (Soft Blue - Wide) */}
            <div
                onClick={() => onBidClick(price)}
                className={`h-full flex items-center justify-center px-2 border-r border-[#cbd5e1] cursor-pointer transition font-black text-xs ${bidQty !== undefined
                    ? 'bg-[#1d70b8] hover:bg-[#165c97] text-white shadow-sm'
                    : 'bg-[#edf2f8] hover:bg-blue-100 text-transparent'
                    }`}
                title={
                    selectedLots > 0
                        ? `Click to BUY ${selectedLots} @ ${price.toFixed(decimals)}`
                        : 'Enter lots > 0 to place BUY order'
                }
            >
                {bidQty !== undefined ? `*${bidQty}` : ''}
            </div>

            {/* 3. Central Stationary Price Column */}
            <div
                onPointerDown={onPointerDown}
                onDoubleClick={onDoubleClick}
                className={`h-full flex items-center justify-center border-r border-[#cbd5e1] font-black text-xs px-1 relative cursor-pointer hover:brightness-95 transition select-none ${isLtp
                    ? 'bg-white text-slate-950 font-extrabold shadow-inner border-y border-blue-500'
                    : 'bg-[#dce1e8] text-slate-800'
                    }`}
                title="Double-click to Re-Center"
            >
                {isHigh && (
                    <div className="absolute top-0 inset-x-0 h-0.5 bg-emerald-600" title="Session High" />
                )}
                {isLow && (
                    <div className="absolute bottom-0 inset-x-0 h-0.5 bg-red-600" title="Session Low" />
                )}
                <span>{price.toFixed(decimals)}</span>
            </div>

            {/* 4. Asks Column (Soft Brick Red - Wide) */}
            <div
                onClick={() => onAskClick(price)}
                className={`h-full flex items-center justify-center px-2 border-r border-[#cbd5e1] cursor-pointer transition font-black text-xs ${askQty !== undefined
                    ? 'bg-[#c53030] hover:bg-[#a82323] text-white shadow-sm'
                    : 'bg-[#fcf2f2] hover:bg-red-100 text-transparent'
                    }`}
                title={
                    selectedLots > 0
                        ? `Click to SELL ${selectedLots} @ ${price.toFixed(decimals)}`
                        : 'Enter lots > 0 to place SELL order'
                }
            >
                {askQty !== undefined ? `*${askQty}` : ''}
            </div>

            {/* 5. Last Traded Qty (LTQ) Column */}
            <div className="h-full flex items-center justify-center bg-[#e2e6ec] text-[10px]">
                {isLtp && latestTradeQty !== undefined && (
                    <span className="bg-[#15803d] text-white font-black px-1.5 py-0.2 rounded text-[9px] shadow-sm">
                        {latestTradeQty}
                    </span>
                )}
            </div>
        </div>
    );
});

LadderRow.displayName = 'LadderRow';

export const LadderWidget: React.FC<LadderWidgetProps> = ({
    instrument,
    depth,
    ticker,
    orders = [],
    recentTrades = [],
    onPlaceOrder,
    onCancelOrder,
    onCancelAll,
}) => {
    const config = INSTRUMENTS[instrument] || {
        name: instrument,
        tickSize: 0.005,
        decimals: 3,
        defaultPrice: 96.0,
        multiplier: 2500,
    };

    const [selectedLots, setSelectedLots] = useState<number>(0);
    const [orderType, setOrderType] = useState<OrderType>('LIMIT');
    const [tif, setTif] = useState<OrderTIF>('DAY');

    const containerRef = useRef<HTMLDivElement | null>(null);
    const lastPointerDownTimeRef = useRef<number>(0);
    const hasHydratedAnchorRef = useRef<boolean>(false);

    const latestTrade = useMemo(() => {
        return (recentTrades || []).find((t) => t.instrument === instrument);
    }, [recentTrades, instrument]);

    const ltp = latestTrade?.price ?? ticker?.last ?? 0;
    const latestTradeQty = latestTrade?.qty ?? ticker?.lastQty;

    const [anchorPrice, setAnchorPrice] = useState<number>(() => {
        return config.defaultPrice || 0;
    });

    const bestBid = depth?.bids?.[0]?.price ?? ticker?.bid ?? 0;
    const bestAsk = depth?.asks?.[0]?.price ?? ticker?.ask ?? 0;

    useEffect(() => {
        hasHydratedAnchorRef.current = false;
    }, [instrument]);

    useEffect(() => {
        if (!hasHydratedAnchorRef.current) {
            const liveRefPrice =
                bestBid > 0 && bestAsk > 0
                    ? (bestBid + bestAsk) / 2
                    : bestBid > 0
                        ? bestBid
                        : bestAsk > 0
                            ? bestAsk
                            : ltp > 0
                                ? ltp
                                : config.defaultPrice;

            if (liveRefPrice > 0) {
                hasHydratedAnchorRef.current = true;
                setAnchorPrice(liveRefPrice);
            }
        }
    }, [bestBid, bestAsk, ltp, config.defaultPrice]);

    const toPriceKey = useCallback(
        (p: number) => Number(p.toFixed(config.decimals)),
        [config.decimals]
    );

    const bidMap = useMemo(() => {
        const map = new Map<number, number>();
        depth?.bids?.forEach((b) => {
            const p = Number(Number(b.price).toFixed(config.decimals));
            map.set(p, b.qty);
        });
        return map;
    }, [depth?.bids, config.decimals]);

    const askMap = useMemo(() => {
        const map = new Map<number, number>();
        depth?.asks?.forEach((a) => {
            const p = Number(Number(a.price).toFixed(config.decimals));
            map.set(p, a.qty);
        });
        return map;
    }, [depth?.asks, config.decimals]);

    const workingOrdersByPrice = useMemo(() => {
        const map = new Map<number, { buyQty: number; sellQty: number; orderIds: string[] }>();
        orders
            .filter((o) => o.instrument === instrument && (o.status === 'WORKING' || o.status === 'SUBMITTED'))
            .forEach((o) => {
                const p = Number(Number(o.price).toFixed(config.decimals));
                const current = map.get(p) || { buyQty: 0, sellQty: 0, orderIds: [] };
                if (o.side === 'BUY') current.buyQty += o.remainingQty || o.qty;
                if (o.side === 'SELL') current.sellQty += o.remainingQty || o.qty;
                current.orderIds.push(o.id);
                map.set(p, current);
            });
        return map;
    }, [orders, instrument, config.decimals]);

    const highPx = ticker?.high || 0;
    const lowPx = ticker?.low || 0;
    const openPx = ticker?.open || ltp;
    const totalVolume = ticker?.volume || 0;
    const netChange = ltp > 0 && openPx > 0 ? ltp - openPx : 0;

    const priceList = useMemo(() => {
        const list: number[] = [];
        const base = Math.round(anchorPrice / config.tickSize) * config.tickSize;

        for (let i = TOTAL_LADDER_TICKS; i >= -TOTAL_LADDER_TICKS; i--) {
            const rawPrice = base + i * config.tickSize;
            const formattedPrice = Number((Math.abs(rawPrice) < 1e-7 ? 0 : rawPrice).toFixed(config.decimals));
            list.push(formattedPrice);
        }
        return list;
    }, [anchorPrice, config.tickSize, config.decimals]);

    const bestBidRef = useRef(bestBid);
    bestBidRef.current = bestBid;

    const bestAskRef = useRef(bestAsk);
    bestAskRef.current = bestAsk;

    const ltpRef = useRef(ltp);
    ltpRef.current = ltp;

    const configRef = useRef(config);
    configRef.current = config;

    const priceListRef = useRef(priceList);
    priceListRef.current = priceList;

    const scrollToCenter = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const bBid = bestBidRef.current;
        const bAsk = bestAskRef.current;
        const lastP = ltpRef.current;
        const cfg = configRef.current;

        let targetPrice = 0;
        if (bBid > 0 && bAsk > 0) {
            const mid = (bBid + bAsk) / 2;
            targetPrice = Number((Math.round(mid / cfg.tickSize) * cfg.tickSize).toFixed(cfg.decimals));
        } else if (bBid > 0) {
            targetPrice = Number(bBid.toFixed(cfg.decimals));
        } else if (bAsk > 0) {
            targetPrice = Number(bAsk.toFixed(cfg.decimals));
        } else if (lastP > 0) {
            targetPrice = Number(lastP.toFixed(cfg.decimals));
        } else {
            targetPrice = 0;
        }

        setAnchorPrice((prevAnchor) => {
            const diffTicks = Math.abs(targetPrice - prevAnchor) / cfg.tickSize;
            if (diffTicks > TOTAL_LADDER_TICKS * 0.6 && targetPrice > 0) {
                return targetPrice;
            }
            return prevAnchor;
        });

        const pList = priceListRef.current;
        let targetIndex = -1;
        let minDiff = Infinity;
        for (let i = 0; i < pList.length; i++) {
            const diff = Math.abs(pList[i] - targetPrice);
            if (diff < minDiff) {
                minDiff = diff;
                targetIndex = i;
                if (diff < cfg.tickSize / 10) break;
            }
        }

        if (targetIndex !== -1) {
            const containerHeight = container.clientHeight || 300;
            const rowOffset = targetIndex * ROW_HEIGHT;
            const targetScrollTop = Math.max(0, rowOffset - containerHeight / 2 + ROW_HEIGHT / 2);

            container.scrollTop = targetScrollTop;
            container.scrollTo({
                top: targetScrollTop,
                behavior: 'smooth',
            });
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            scrollToCenter();
        }, 200);
        return () => clearTimeout(timer);
    }, [instrument, scrollToCenter]);

    useEffect(() => {
        const interval = setInterval(() => {
            scrollToCenter();
        }, 30000);

        return () => clearInterval(interval);
    }, [scrollToCenter]);

    const handlePricePointerDown = useCallback((e: React.PointerEvent | React.MouseEvent) => {
        e.stopPropagation();
        const now = Date.now();
        if (now - lastPointerDownTimeRef.current < 400) {
            scrollToCenter();
            lastPointerDownTimeRef.current = 0;
        } else {
            lastPointerDownTimeRef.current = now;
        }
    }, [scrollToCenter]);

    const handleBidCellClick = useCallback((price: number) => {
        if (selectedLots <= 0) return;
        onPlaceOrder({
            instrument,
            side: 'BUY',
            type: orderType,
            price,
            qty: selectedLots,
            tif,
        });
    }, [instrument, orderType, selectedLots, tif, onPlaceOrder]);

    const handleAskCellClick = useCallback((price: number) => {
        if (selectedLots <= 0) return;
        onPlaceOrder({
            instrument,
            side: 'SELL',
            type: orderType,
            price,
            qty: selectedLots,
            tif,
        });
    }, [instrument, orderType, selectedLots, tif, onPlaceOrder]);

    const handleCancelLevelOrders = useCallback((orderIds: string[]) => {
        if (!onCancelOrder) return;
        orderIds.forEach((id) => onCancelOrder(id, instrument));
    }, [instrument, onCancelOrder]);

    const handleCancelSide = (side: 'BUY' | 'SELL') => {
        if (!onCancelOrder) return;
        orders
            .filter((o) => o.instrument === instrument && o.side === side && (o.status === 'WORKING' || o.status === 'SUBMITTED'))
            .forEach((o) => onCancelOrder(o.id, instrument));
    };

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
            return;
        }

        if (e.key >= '0' && e.key <= '9') {
            e.preventDefault();
            setSelectedLots((prev) => {
                const nextStr = prev === 0 ? e.key : `${prev}${e.key}`;
                const num = parseInt(nextStr, 10);
                return isNaN(num) ? 0 : Math.min(10000, num);
            });
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            setSelectedLots((prev) => {
                const str = prev.toString();
                if (str.length <= 1) return 0;
                return parseInt(str.slice(0, -1), 10) || 0;
            });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedLots((prev) => prev + 1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedLots((prev) => Math.max(0, prev - 1));
        } else if (e.key === 'c' || e.key === 'C' || e.key === 'Escape') {
            e.preventDefault();
            setSelectedLots(0);
        }
    }, []);

    return (
        <div
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="w-full h-full min-h-0 flex flex-col bg-[#edf0f5] text-slate-900 font-mono text-xs select-none overflow-hidden outline-none focus:ring-1 focus:ring-[#94a3b8]"
        >
            {/* Header Market Stats Strip */}
            <div className="bg-[#d4d8df] border-b border-[#b4bcc8] px-3 py-1.5 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                    <div
                        className={`font-black text-sm tracking-wide ${netChange >= 0 ? 'text-emerald-700' : 'text-red-700'
                            }`}
                    >
                        {netChange >= 0 ? `+${netChange.toFixed(config.decimals)}` : netChange.toFixed(config.decimals)}
                    </div>
                    <div className="flex items-center gap-3 text-[11px]">
                        <div>
                            <span className="text-slate-600 mr-1 font-semibold">H:</span>
                            <span className="text-emerald-700 font-bold">{highPx > 0 ? highPx.toFixed(config.decimals) : '—'}</span>
                        </div>
                        <div>
                            <span className="text-slate-600 mr-1 font-semibold">L:</span>
                            <span className="text-red-700 font-bold">{lowPx > 0 ? lowPx.toFixed(config.decimals) : '—'}</span>
                        </div>
                        <div>
                            <span className="text-slate-600 mr-1 font-semibold">LTP:</span>
                            <span className="text-slate-900 font-black">{ltp > 0 ? ltp.toFixed(config.decimals) : '—'}</span>
                        </div>
                        <div>
                            <span className="text-slate-600 mr-1 font-semibold">LTQ:</span>
                            <span className="text-amber-800 font-bold">{latestTradeQty !== undefined ? latestTradeQty : '—'}</span>
                        </div>
                        <div>
                            <span className="text-slate-600 mr-1 font-semibold">Vol:</span>
                            <span className="text-slate-800 font-bold" title="Total Lots Traded Today">
                                {totalVolume.toLocaleString()}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={scrollToCenter}
                        className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 rounded border border-[#b4bcc8] text-[10px] font-bold transition active:scale-95 shadow-sm"
                        title="Re-Center ladder to middle"
                    >
                        <Target size={11} className="text-blue-700" />
                        <span>Center</span>
                    </button>
                </div>
            </div>

            {/* Main Body: Compact Left Controls + Full DOM Ladder */}
            <div className="flex-1 min-h-0 flex">
                <div className="w-[124px] bg-[#d8dce2] border-r border-[#b4bcc8] p-1.5 flex flex-col justify-between shrink-0 select-none">
                    <div className="space-y-2">
                        {/* Type & TIF Dropdowns */}
                        <div className="space-y-1">
                            <div className="grid grid-cols-2 gap-1">
                                <button
                                    onClick={() => setOrderType('LIMIT')}
                                    className={`py-0.5 text-[9px] font-extrabold rounded transition ${orderType === 'LIMIT'
                                        ? 'bg-[#1d70b8] text-white shadow-sm'
                                        : 'bg-white text-slate-700 border border-[#b4bcc8] hover:bg-slate-100'
                                        }`}
                                >
                                    LMT
                                </button>
                                <button
                                    onClick={() => setOrderType('MARKET')}
                                    className={`py-0.5 text-[9px] font-extrabold rounded transition ${orderType === 'MARKET'
                                        ? 'bg-[#1d70b8] text-white shadow-sm'
                                        : 'bg-white text-slate-700 border border-[#b4bcc8] hover:bg-slate-100'
                                        }`}
                                >
                                    MKT
                                </button>
                            </div>

                            <select
                                value={tif}
                                onChange={(e) => setTif(e.target.value as OrderTIF)}
                                className="w-full bg-white border border-[#b4bcc8] text-slate-800 text-[9px] font-bold rounded px-1 py-0.5 outline-none shadow-sm"
                            >
                                <option value="DAY">DAY</option>
                                <option value="GTC">GTC</option>
                                <option value="IOC">IOC</option>
                                <option value="FOK">FOK</option>
                            </select>
                        </div>

                        {/* Quantity / Lots Entry */}
                        <div className="space-y-1">
                            <div className="text-[9px] text-slate-600 font-bold uppercase tracking-wider flex justify-between">
                                <span>Lots:</span>
                                <span className={selectedLots > 0 ? "text-blue-700 font-black" : "text-amber-800 font-bold"}>
                                    {selectedLots > 0 ? `${selectedLots} L` : '0 (Empty)'}
                                </span>
                            </div>

                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => setSelectedLots((prev) => Math.max(0, prev - 1))}
                                    className="w-5 h-6 bg-white hover:bg-slate-100 text-slate-800 font-bold rounded flex items-center justify-center border border-[#b4bcc8] text-xs shadow-sm"
                                >
                                    -
                                </button>
                                <input
                                    type="number"
                                    min="0"
                                    max="10000"
                                    value={selectedLots === 0 ? '' : selectedLots}
                                    placeholder="0"
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value, 10);
                                        setSelectedLots(isNaN(val) ? 0 : Math.max(0, val));
                                    }}
                                    className="w-full h-6 bg-white border border-[#b4bcc8] focus:border-[#1d70b8] rounded text-center text-xs font-black text-slate-900 outline-none shadow-inner"
                                />
                                <button
                                    onClick={() => setSelectedLots((prev) => prev + 1)}
                                    className="w-5 h-6 bg-white hover:bg-slate-100 text-slate-800 font-bold rounded flex items-center justify-center border border-[#b4bcc8] text-xs shadow-sm"
                                >
                                    +
                                </button>
                            </div>

                            {/* Preset Buttons Grid */}
                            <div className="grid grid-cols-2 gap-1 pt-0.5">
                                {[1, 5, 10, 25, 50].map((preset) => (
                                    <button
                                        key={preset}
                                        onClick={() => setSelectedLots(preset)}
                                        className={`py-0.5 text-[10px] font-bold rounded transition border shadow-sm ${selectedLots === preset
                                            ? 'bg-[#1d70b8] text-white border-[#165c97]'
                                            : 'bg-white hover:bg-slate-100 text-slate-800 border-[#b4bcc8]'
                                            }`}
                                    >
                                        {preset}
                                    </button>
                                ))}
                                <button
                                    onClick={() => setSelectedLots(0)}
                                    className="py-0.5 text-[10px] font-bold rounded bg-white hover:bg-amber-50 text-amber-800 hover:text-amber-900 border border-[#b4bcc8] transition shadow-sm"
                                    title="Clear quantity to 0"
                                >
                                    CLR
                                </button>
                            </div>
                        </div>

                        {/* Cancel Action Buttons */}
                        <div className="space-y-1 pt-1 border-t border-[#b4bcc8]">
                            <button
                                onClick={() => handleCancelSide('SELL')}
                                className="w-full py-0.5 bg-[#c53030] hover:bg-[#a82323] text-white text-[10px] font-bold rounded shadow-sm transition active:scale-95"
                            >
                                CXL S
                            </button>
                            <button
                                onClick={() => onCancelAll?.(instrument)}
                                className="w-full py-0.5 bg-slate-600 hover:bg-slate-700 text-white text-[10px] font-bold rounded shadow-sm transition active:scale-95"
                            >
                                CXL All
                            </button>
                            <button
                                onClick={() => handleCancelSide('BUY')}
                                className="w-full py-0.5 bg-[#1d70b8] hover:bg-[#165c97] text-white text-[10px] font-bold rounded shadow-sm transition active:scale-95"
                            >
                                CXL B
                            </button>
                        </div>
                    </div>

                    <div className="pt-1.5 border-t border-[#b4bcc8] text-[9px] text-slate-600 space-y-0.5">
                        <div className="flex justify-between">
                            <span>Tick:</span>
                            <span className="font-bold text-slate-800">{config.tickSize}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[9px] text-slate-600">
                            <RotateCcw size={9} className="text-blue-700" />
                            <span>Center (30s)</span>
                        </div>
                    </div>
                </div>

                {/* Central DOM Ladder */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#edf0f5]">
                    <div className="grid grid-cols-[36px_1fr_76px_1fr_36px] bg-[#cbd2dc] border-b border-[#b4bcc8] text-[11px] font-extrabold text-slate-800 text-center py-1 shrink-0">
                        <div className="border-r border-[#b4bcc8]">Work</div>
                        <div className="bg-[#1d70b8] text-white border-r border-[#b4bcc8] tracking-wider">Bids</div>
                        <div
                            onPointerDown={handlePricePointerDown}
                            onDoubleClick={scrollToCenter}
                            className="bg-[#64748b] text-white border-r border-[#b4bcc8] cursor-pointer hover:bg-[#475569] transition select-none"
                            title="Double-click to Re-Center to Middle"
                        >
                            Price
                        </div>
                        <div className="bg-[#c53030] text-white border-r border-[#b4bcc8] tracking-wider">Asks</div>
                        <div>LTQ</div>
                    </div>

                    <div
                        ref={containerRef}
                        className="flex-1 min-h-0 overflow-y-auto divide-y divide-[#cbd5e1]/60 select-none relative"
                    >
                        {priceList.map((price) => {
                            const pKey = toPriceKey(price);
                            const bidQty = bidMap.get(pKey);
                            const askQty = askMap.get(pKey);
                            const working = workingOrdersByPrice.get(pKey);
                            const workingQty = working ? working.buyQty || working.sellQty : undefined;
                            const workingSide = working ? (working.buyQty > 0 ? 'BUY' : 'SELL') : undefined;

                            const isLtp = ltp > 0 && Math.abs(price - ltp) < config.tickSize / 2;
                            const isHigh = highPx > 0 && Math.abs(price - highPx) < config.tickSize / 2;
                            const isLow = lowPx > 0 && Math.abs(price - lowPx) < config.tickSize / 2;
                            const isSpreadDivider = bestBid > 0 && Math.abs(price - bestBid) < config.tickSize / 2 && price < bestAsk;

                            return (
                                <LadderRow
                                    key={price}
                                    price={price}
                                    decimals={config.decimals}
                                    bidQty={bidQty}
                                    askQty={askQty}
                                    workingQty={workingQty}
                                    workingSide={workingSide}
                                    workingOrderIds={working?.orderIds}
                                    isLtp={isLtp}
                                    isHigh={isHigh}
                                    isLow={isLow}
                                    isSpreadDivider={isSpreadDivider}
                                    latestTradeQty={isLtp ? latestTradeQty : undefined}
                                    selectedLots={selectedLots}
                                    onBidClick={handleBidCellClick}
                                    onAskClick={handleAskCellClick}
                                    onCancelLevel={handleCancelLevelOrders}
                                    onPointerDown={handlePricePointerDown}
                                    onDoubleClick={scrollToCenter}
                                />
                            );
                        })}
                    </div>

                    <div className="bg-[#d4d8df] border-t border-[#b4bcc8] px-2 py-1 flex items-center justify-between shrink-0 text-xs">
                        <div className="flex items-center gap-1">
                            <span
                                className={`text-[10px] font-black px-2 py-0.5 rounded ${selectedLots > 0 ? 'bg-[#1d70b8] text-white' : 'bg-slate-300 text-slate-800'
                                    }`}
                            >
                                {instrument} {selectedLots}L
                            </span>
                        </div>

                        <button
                            onClick={scrollToCenter}
                            className="flex items-center gap-1 px-3 py-0.5 bg-[#1d70b8] hover:bg-[#165c97] text-white font-bold rounded text-[10px] shadow-sm transition active:scale-95"
                            title="Re-Center ladder to middle"
                        >
                            <Target size={11} />
                            <span>Center</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};