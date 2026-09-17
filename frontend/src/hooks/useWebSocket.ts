// import { useEffect, useRef, useState, useCallback } from 'react';
// import { INSTRUMENTS } from '../constants/instruments';
// import type { DepthBook, PriceTicker } from '../types/instrument';
// import type { Fill, FillAlertItem, Order, PIQData, Position, OrderSide } from '../types/order';
// import { playFillChime, playRejectBuzz } from '../utils/audio';

// interface UseWebSocketOptions {
//     token: string | null;
//     traderId: string | null;
//     activeSymbols: string[];
//     onFillReceived?: (fill: FillAlertItem) => void;
// }

// interface MutableMessageBuffer {
//     prices: Map<string, PriceTicker>;
//     depths: Map<string, DepthBook>;
//     incomingTrades: Fill[];
//     tradesBySymbol: Map<string, Fill[]>;
//     traderFills: Fill[];
//     orders: Partial<Order>[];
//     piq: Map<string, PIQData>;
//     positions: Map<string, Position>;
//     alertFills: FillAlertItem[];
//     hasUpdates: boolean;
// }

// export function useWebSocket({ token, traderId, activeSymbols, onFillReceived }: UseWebSocketOptions) {
//     const [isConnected, setIsConnected] = useState<boolean>(false);
//     const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
//     const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

//     const [tickers, setTickers] = useState<Record<string, PriceTicker>>({});
//     const [depths, setDepths] = useState<Record<string, DepthBook>>({});
//     const [recentTrades, setRecentTrades] = useState<Fill[]>([]);
//     const [tradesBySymbol, setTradesBySymbol] = useState<Record<string, Fill[]>>({});
//     const [traderFills, setTraderFills] = useState<Fill[]>([]);
//     const [orders, setOrders] = useState<Order[]>([]);
//     const [positions, setPositions] = useState<Position[]>([]);
//     const [piqMap, setPiqMap] = useState<Record<string, PIQData>>({});
//     const [alertFills, setAlertFills] = useState<FillAlertItem[]>([]);
//     const [riskAlert, setRiskAlert] = useState<{ message: string; timestamp: string } | null>(null);

//     const wsRef = useRef<WebSocket | null>(null);
//     const reconnectTimeoutRef = useRef<any>(null);
//     const pingIntervalRef = useRef<any>(null);
//     const rafIdRef = useRef<number | null>(null);
//     const onFillReceivedRef = useRef(onFillReceived);
//     onFillReceivedRef.current = onFillReceived;

//     const seenFillIdsRef = useRef<Set<string>>(new Set());

//     const bufferRef = useRef<MutableMessageBuffer>({
//         prices: new Map(),
//         depths: new Map(),
//         incomingTrades: [],
//         tradesBySymbol: new Map(),
//         traderFills: [],
//         orders: [],
//         piq: new Map(),
//         positions: new Map(),
//         alertFills: [],
//         hasUpdates: false,
//     });

//     // 1. Initial Market Snapshot & Historical Time & Sales (TAS) Hydration
//     const hydrateMarketSnapshot = useCallback(async (symbol: string) => {
//         try {
//             const depthPromise = fetch(`/api/market/depth/${encodeURIComponent(symbol)}`);
//             const tapePromise = fetch(`/api/market/tape/${encodeURIComponent(symbol)}?limit=200`);

//             const [depthRes, tapeRes] = await Promise.allSettled([depthPromise, tapePromise]);

//             if (depthRes.status === 'fulfilled' && depthRes.value.ok) {
//                 const bookData = await depthRes.value.json();
//                 const depthSnapshot: DepthBook = {
//                     instrument: symbol,
//                     bids: bookData.bids || [],
//                     asks: bookData.asks || [],
//                     timestamp: new Date().toISOString(),
//                 };

//                 setDepths((prev) => ({
//                     ...prev,
//                     [symbol]: depthSnapshot,
//                 }));

//                 const bestBid = bookData.bids?.[0]?.price ?? bookData.bestBid ?? 0;
//                 const bestAsk = bookData.asks?.[0]?.price ?? bookData.bestAsk ?? 0;
//                 const midPrice = bestBid && bestAsk ? Number(((bestBid + bestAsk) / 2).toFixed(2)) : bestBid || bestAsk;

//                 setTickers((prev) => ({
//                     ...prev,
//                     [symbol]: {
//                         instrument: symbol,
//                         bid: bestBid,
//                         ask: bestAsk,
//                         last: prev[symbol]?.last || midPrice,
//                         lastQty: prev[symbol]?.lastQty,
//                         volume: prev[symbol]?.volume || 0,
//                         timestamp: new Date().toISOString(),
//                     },
//                 }));
//             }

//             if (tapeRes.status === 'fulfilled' && tapeRes.value.ok) {
//                 const rawTrades = await tapeRes.value.json();
//                 if (Array.isArray(rawTrades) && rawTrades.length > 0) {
//                     const historicalTrades: Fill[] = rawTrades.map((t: any) => {
//                         const rawSide = t.side || t.aggressorSide || t.aggressor_side || 'BUY';
//                         const side: OrderSide = String(rawSide).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

//                         return {
//                             id: t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`,
//                             orderId: t.orderId || '',
//                             buyerId: t.buyerId || '',
//                             sellerId: t.sellerId || '',
//                             instrument: t.instrument || symbol,
//                             side: side,
//                             price: Number(t.price),
//                             qty: Number(t.qty),
//                             time: t.time || new Date().toISOString(),
//                             aggressorSide: side,
//                         };
//                     });

//                     // Newest first
//                     historicalTrades.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
//                     const latestTrade = historicalTrades[0];

//                     const buf = bufferRef.current;
//                     const existing = buf.tradesBySymbol.get(symbol) || [];

//                     const seenKeys = new Set<string>();
//                     const merged: Fill[] = [];

//                     for (const t of existing) {
//                         const key = t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`;
//                         if (!seenKeys.has(key)) {
//                             seenKeys.add(key);
//                             merged.push(t);
//                         }
//                     }
//                     for (const t of historicalTrades) {
//                         const key = t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`;
//                         if (!seenKeys.has(key)) {
//                             seenKeys.add(key);
//                             merged.push(t);
//                         }
//                     }

//                     merged.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
//                     const final200 = merged.slice(0, 200);

//                     buf.tradesBySymbol.set(symbol, final200);

//                     if (latestTrade) {
//                         setTickers((prev) => ({
//                             ...prev,
//                             [symbol]: {
//                                 ...(prev[symbol] || {
//                                     instrument: symbol,
//                                     bid: 0,
//                                     ask: 0,
//                                     volume: 0,
//                                     timestamp: new Date().toISOString(),
//                                 }),
//                                 last: latestTrade.price,
//                                 lastQty: latestTrade.qty,
//                             }
//                         }));
//                     }

//                     buf.hasUpdates = true;
//                 }
//             }
//         } catch (err) {
//             console.warn(`[Hydration] Failed snapshot for ${symbol}:`, err);
//         }
//     }, []);

//     // 2. Initial User Data & Full Historical Fill Book Hydration
//     const hydrateUserData = useCallback(async (authToken: string) => {
//         try {
//             // A. Hydrate Positions
//             const posRes = await fetch('/api/trading/positions', {
//                 headers: { Authorization: `Bearer ${authToken}` },
//             });
//             if (posRes.ok) {
//                 const posData: Position[] = await posRes.json();
//                 setPositions(posData);
//                 posData.forEach((p) => bufferRef.current.positions.set(p.instrument, p));
//             }

//             // B. Hydrate Active Working Orders
//             const ordRes = await fetch('/api/trading/orders', {
//                 headers: { Authorization: `Bearer ${authToken}` },
//             });
//             if (ordRes.ok) {
//                 const ordData: Order[] = await ordRes.json();
//                 setOrders(ordData);
//             }

//             // C. Hydrate ALL Trader Historical Fills from Database
//             const fillsRes = await fetch('/api/trading/trades', {
//                 headers: { Authorization: `Bearer ${authToken}` },
//             });
//             if (fillsRes.ok) {
//                 const fillsData: Fill[] = await fillsRes.json();
//                 const sortedFills: Fill[] = fillsData.map((f: any) => {
//                     const rawSide = f.side || f.userSide || f.user_side || (f.buyerId === traderId ? 'BUY' : f.sellerId === traderId ? 'SELL' : 'BUY');
//                     const side: OrderSide = String(rawSide).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

//                     return {
//                         id: f.id,
//                         orderId: f.orderId || '',
//                         buyerId: f.buyerId || '',
//                         sellerId: f.sellerId || '',
//                         instrument: f.instrument,
//                         side,
//                         price: Number(f.price),
//                         qty: Number(f.qty),
//                         time: f.time || new Date().toISOString(),
//                         aggressorSide: f.aggressorSide,
//                     };
//                 });

//                 sortedFills.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

//                 setTraderFills(sortedFills);
//                 bufferRef.current.traderFills = [...sortedFills];

//                 // Populate initial alert fills
//                 const initialAlertFills: FillAlertItem[] = sortedFills.map((f) => {
//                     const meta = INSTRUMENTS[f.instrument];
//                     return {
//                         id: `fill_init_${f.id}`,
//                         transactTime: f.time,
//                         exchange: meta?.exchange || 'CME',
//                         contract: f.instrument,
//                         side: f.side,
//                         filledQty: f.qty,
//                         price: f.price,
//                         exeQty: f.qty,
//                         orderId: f.orderId,
//                         notional: f.qty * f.price * (meta?.multiplier || 1),
//                         account: traderId || undefined,
//                     };
//                 });
//                 initialAlertFills.forEach((af) => seenFillIdsRef.current.add(af.id));
//                 setAlertFills(initialAlertFills);
//             }
//         } catch (err) {
//             console.warn('[Hydration] Failed user data hydration:', err);
//         }
//     }, [traderId]);

//     // 3. High-Frequency Throttled RAF Batch Flush Loop (30-60 FPS)
//     useEffect(() => {
//         let lastFlushTime = 0;

//         const flushBatch = (timestamp: number) => {
//             const buf = bufferRef.current;

//             if (buf.hasUpdates && timestamp - lastFlushTime >= 33) {
//                 lastFlushTime = timestamp;

//                 if (buf.prices.size > 0) {
//                     const pricesToFlush = new Map(buf.prices);
//                     buf.prices.clear();
//                     setTickers((prev) => {
//                         const next = { ...prev };
//                         pricesToFlush.forEach((ticker, sym) => {
//                             next[sym] = {
//                                 ...(prev[sym] || {}),
//                                 ...ticker,
//                             };
//                         });
//                         return next;
//                     });
//                 }

//                 if (buf.depths.size > 0) {
//                     const depthsToFlush = new Map(buf.depths);
//                     buf.depths.clear();
//                     setDepths((prev) => {
//                         const next = { ...prev };
//                         depthsToFlush.forEach((depth, sym) => {
//                             next[sym] = depth;
//                         });
//                         return next;
//                     });
//                 }

//                 // Flush Time & Sales incoming trades
//                 if (buf.incomingTrades.length > 0) {
//                     const tradesToFlush = [...buf.incomingTrades];
//                     buf.incomingTrades = [];

//                     for (const t of tradesToFlush) {
//                         const sym = t.instrument;
//                         const currentList = buf.tradesBySymbol.get(sym) || [];
//                         const key = t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`;

//                         const isDuplicate = currentList.some(
//                             (item) => (item.id && item.id === t.id) || `${item.time}_${item.instrument}_${item.price}_${item.qty}` === key
//                         );

//                         if (!isDuplicate) {
//                             const updated = [t, ...currentList];
//                             updated.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
//                             buf.tradesBySymbol.set(sym, updated.slice(0, 200));
//                         }
//                     }
//                 }

//                 const nextTradesBySymbol: Record<string, Fill[]> = {};
//                 const allRecent: Fill[] = [];

//                 buf.tradesBySymbol.forEach((list, sym) => {
//                     nextTradesBySymbol[sym] = list;
//                     allRecent.push(...list);
//                 });

//                 allRecent.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

//                 setTradesBySymbol(nextTradesBySymbol);
//                 setRecentTrades(allRecent.slice(0, 500));

//                 // Flush Trader Fills (Fill Book)
//                 if (buf.traderFills.length > 0) {
//                     setTraderFills([...buf.traderFills]);
//                 }

//                 if (buf.orders.length > 0) {
//                     const ordersToFlush = [...buf.orders];
//                     buf.orders = [];
//                     setOrders((prev) => {
//                         const orderMap = new Map(prev.map((o) => [o.id, o]));
//                         ordersToFlush.forEach((newOrder) => {
//                             const oid = newOrder.id || (newOrder as any).orderId;
//                             if (!oid) return;
//                             const existing = orderMap.get(oid);
//                             if (existing) {
//                                 orderMap.set(oid, { ...existing, ...newOrder, id: oid } as Order);
//                             } else {
//                                 orderMap.set(oid, { ...newOrder, id: oid } as Order);
//                             }
//                         });
//                         return Array.from(orderMap.values());
//                     });
//                 }

//                 if (buf.piq.size > 0) {
//                     const piqToFlush = new Map(buf.piq);
//                     buf.piq.clear();
//                     setPiqMap((prev) => {
//                         const next = { ...prev };
//                         piqToFlush.forEach((data, orderId) => {
//                             next[orderId] = data;
//                         });
//                         return next;
//                     });
//                 }

//                 if (buf.positions.size > 0) {
//                     const posToFlush = new Map(buf.positions);
//                     buf.positions.clear();
//                     setPositions((prev) => {
//                         const posMap = new Map(prev.map((p) => [p.instrument, p]));
//                         posToFlush.forEach((p, inst) => {
//                             posMap.set(inst, p);
//                         });
//                         return Array.from(posMap.values());
//                     });
//                 }

//                 if (buf.alertFills.length > 0) {
//                     const fillsToFlush = [...buf.alertFills];
//                     buf.alertFills = [];
//                     setAlertFills((prev) => {
//                         const seen = new Set<string>();
//                         const combined = [...fillsToFlush, ...prev];
//                         const unique: FillAlertItem[] = [];
//                         for (const f of combined) {
//                             if (!seen.has(f.id)) {
//                                 seen.add(f.id);
//                                 unique.push(f);
//                             }
//                         }
//                         return unique.slice(0, 300);
//                     });
//                 }

//                 buf.hasUpdates = false;
//             }

//             rafIdRef.current = requestAnimationFrame(flushBatch);
//         };

//         rafIdRef.current = requestAnimationFrame(flushBatch);
//         return () => {
//             if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
//         };
//     }, []);

//     const sendAction = useCallback((action: any) => {
//         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
//             wsRef.current.send(JSON.stringify(action));
//             return true;
//         }
//         return false;
//     }, []);

//     const placeOrder = useCallback(
//         (params: {
//             instrument: string;
//             side: 'BUY' | 'SELL';
//             type: 'LIMIT' | 'MARKET';
//             price: number;
//             qty: number;
//             tif: 'DAY' | 'GTC' | 'IOC' | 'FOK';
//         }) => {
//             return sendAction({ action: 'PLACE_ORDER', ...params });
//         },
//         [sendAction]
//     );

//     const cancelOrder = useCallback(
//         (orderId: string, instrument: string) => {
//             setOrders((prev) =>
//                 prev.map((o) => (o.id === orderId ? { ...o, status: 'CANCELLING' } : o))
//             );
//             return sendAction({ action: 'CANCEL_ORDER', orderId, instrument });
//         },
//         [sendAction]
//     );

//     const clearAlertFills = useCallback(() => {
//         setAlertFills([]);
//     }, []);

//     const activeSymbolsKey = activeSymbols.slice().sort().join(',');

//     // 4. WebSocket Ingestion & Connection
//     useEffect(() => {
//         if (!token) return;

//         let isMounted = true;

//         activeSymbols.forEach((sym) => hydrateMarketSnapshot(sym));
//         hydrateUserData(token);

//         const connect = () => {
//             if (wsRef.current?.readyState === WebSocket.OPEN) return;

//             const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
//             const wsUrl = `${protocol}//${window.location.hostname}:4006/ws?token=${token}`;

//             console.log(`[WS] Connecting to ${wsUrl}...`);
//             const ws = new WebSocket(wsUrl);
//             wsRef.current = ws;

//             ws.onopen = () => {
//                 if (!isMounted) return;
//                 console.log('[WS] Connected successfully.');
//                 setIsConnected(true);
//                 setIsReconnecting(false);
//                 setReconnectAttempt(0);

//                 activeSymbols.forEach((sym) => {
//                     ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `depth:${sym}` }));
//                     ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `trades:${sym}` }));
//                     ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `ticker:${sym}` }));
//                 });

//                 if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
//                 pingIntervalRef.current = setInterval(() => {
//                     if (ws.readyState === WebSocket.OPEN) {
//                         ws.send(JSON.stringify({ action: 'PING', timestamp: Date.now() }));
//                     }
//                 }, 10000);
//             };

//             ws.onmessage = (event) => {
//                 try {
//                     const msg = JSON.parse(event.data);
//                     const buf = bufferRef.current;

//                     switch (msg.type) {
//                         case 'PRICE_TICK':
//                         case 'PRICE_UPDATE': {
//                             const prev = buf.prices.get(msg.instrument);
//                             const ticker: PriceTicker = {
//                                 instrument: msg.instrument,
//                                 bid: Number(msg.bid || msg.bestBid || prev?.bid || 0),
//                                 ask: Number(msg.ask || msg.bestAsk || prev?.ask || 0),
//                                 last: Number(msg.last || prev?.last || 0),
//                                 lastQty: msg.lastQty !== undefined ? Number(msg.lastQty) : prev?.lastQty,
//                                 high: msg.high !== undefined ? Number(msg.high) : prev?.high,
//                                 low: msg.low !== undefined ? Number(msg.low) : prev?.low,
//                                 open: msg.open !== undefined ? Number(msg.open) : prev?.open,
//                                 volume: Number(msg.volume || prev?.volume || 0),
//                                 timestamp: msg.timestamp || new Date().toISOString(),
//                             };
//                             buf.prices.set(msg.instrument, ticker);
//                             buf.hasUpdates = true;
//                             break;
//                         }

//                         case 'DEPTH_UPDATE':
//                         case 'BOOK_DEPTH': {
//                             const depth: DepthBook = {
//                                 instrument: msg.instrument,
//                                 bids: msg.bids || [],
//                                 asks: msg.asks || [],
//                                 timestamp: msg.timestamp || new Date().toISOString(),
//                             };
//                             buf.depths.set(msg.instrument, depth);
//                             buf.hasUpdates = true;
//                             break;
//                         }

//                         case 'TRADE_TICK':
//                         case 'TRADE': {
//                             const trade = msg.trade || msg.data;
//                             if (trade) {
//                                 const side: OrderSide = (trade.aggressorSide || trade.side || 'BUY') as OrderSide;
//                                 const tradePrice = Number(trade.price);
//                                 const tradeQty = Number(trade.qty);
//                                 const formattedTrade: Fill = {
//                                     id: trade.id || trade.tradeId || `${trade.time}_${trade.instrument}_${trade.price}_${trade.qty}`,
//                                     orderId: trade.buyOrderId || trade.sellOrderId || trade.orderId || '',
//                                     buyerId: trade.buyerId || '',
//                                     sellerId: trade.sellerId || '',
//                                     instrument: trade.instrument,
//                                     side: side,
//                                     price: tradePrice,
//                                     qty: tradeQty,
//                                     time: trade.time || trade.timestamp || new Date().toISOString(),
//                                     aggressorSide: side,
//                                 };

//                                 buf.incomingTrades.push(formattedTrade);

//                                 // Update price ticker with latest traded price and quantity
//                                 const prevTicker = buf.prices.get(trade.instrument);
//                                 buf.prices.set(trade.instrument, {
//                                     instrument: trade.instrument,
//                                     bid: prevTicker?.bid || 0,
//                                     ask: prevTicker?.ask || 0,
//                                     last: tradePrice,
//                                     lastQty: tradeQty,
//                                     volume: (prevTicker?.volume || 0) + tradeQty,
//                                     high: prevTicker?.high ? Math.max(prevTicker.high, tradePrice) : tradePrice,
//                                     low: prevTicker?.low ? Math.min(prevTicker.low, tradePrice) : tradePrice,
//                                     open: prevTicker?.open,
//                                     timestamp: formattedTrade.time,
//                                 });

//                                 buf.hasUpdates = true;
//                             }
//                             break;
//                         }

//                         case 'EXECUTION_FILL': {
//                             playFillChime();
//                             const trade = msg.trade || msg.data;
//                             if (trade) {
//                                 const side: OrderSide = (msg.side || (trade.buyerId === traderId ? 'BUY' : 'SELL')) as OrderSide;
//                                 const fillId = trade.id || `fill_${Date.now()}_${Math.random()}`;
//                                 const tradePrice = Number(trade.price);
//                                 const tradeQty = Number(trade.qty);

//                                 // Add to Fill Book state (traderFills)
//                                 const newTraderFill: Fill = {
//                                     id: fillId,
//                                     orderId: side === 'BUY' ? trade.buyOrderId : trade.sellOrderId,
//                                     buyerId: trade.buyerId,
//                                     sellerId: trade.sellerId,
//                                     instrument: trade.instrument,
//                                     side,
//                                     price: tradePrice,
//                                     qty: tradeQty,
//                                     time: trade.time || trade.timestamp || new Date().toISOString(),
//                                     aggressorSide: trade.aggressorSide || side,
//                                 };

//                                 const existingFills = buf.traderFills;
//                                 const isDup = existingFills.some(
//                                     (f) => (f.id && f.id === fillId) || `${f.time}_${f.instrument}_${f.price}_${f.qty}` === `${newTraderFill.time}_${newTraderFill.instrument}_${newTraderFill.price}_${newTraderFill.qty}`
//                                 );

//                                 if (!isDup) {
//                                     buf.traderFills = [newTraderFill, ...existingFills];
//                                     buf.hasUpdates = true;
//                                 }

//                                 // Update price ticker
//                                 const prevTicker = buf.prices.get(trade.instrument);
//                                 buf.prices.set(trade.instrument, {
//                                     instrument: trade.instrument,
//                                     bid: prevTicker?.bid || 0,
//                                     ask: prevTicker?.ask || 0,
//                                     last: tradePrice,
//                                     lastQty: tradeQty,
//                                     volume: (prevTicker?.volume || 0) + tradeQty,
//                                     high: prevTicker?.high ? Math.max(prevTicker.high, tradePrice) : tradePrice,
//                                     low: prevTicker?.low ? Math.min(prevTicker.low, tradePrice) : tradePrice,
//                                     open: prevTicker?.open,
//                                     timestamp: newTraderFill.time,
//                                 });

//                                 // Trigger Fill Alert Widget
//                                 if (!seenFillIdsRef.current.has(fillId)) {
//                                     seenFillIdsRef.current.add(fillId);
//                                     const meta = INSTRUMENTS[trade.instrument];
//                                     const fillAlert: FillAlertItem = {
//                                         id: fillId,
//                                         transactTime: trade.time || trade.timestamp || new Date().toISOString(),
//                                         exchange: meta?.exchange || 'CME',
//                                         contract: trade.instrument,
//                                         side,
//                                         filledQty: tradeQty,
//                                         price: tradePrice,
//                                         exeQty: tradeQty,
//                                         orderId: side === 'BUY' ? trade.buyOrderId : trade.sellOrderId,
//                                         notional: tradeQty * tradePrice * (meta?.multiplier || 1),
//                                         account: traderId || undefined,
//                                     };
//                                     buf.alertFills.unshift(fillAlert);
//                                     buf.hasUpdates = true;
//                                     if (onFillReceivedRef.current) {
//                                         onFillReceivedRef.current(fillAlert);
//                                     }
//                                 }
//                             }
//                             break;
//                         }

//                         case 'ORDER_SUBMITTED':
//                             buf.orders.push({
//                                 id: msg.orderId,
//                                 instrument: msg.instrument,
//                                 side: msg.side,
//                                 price: msg.price,
//                                 qty: msg.qty,
//                                 filledQty: 0,
//                                 remainingQty: msg.qty,
//                                 status: 'SUBMITTED',
//                                 createdAt: msg.timestamp,
//                                 updatedAt: msg.timestamp,
//                             });
//                             buf.hasUpdates = true;
//                             break;

//                         case 'ORDER_EVENT': {
//                             const ev = msg.event || msg;
//                             const orderId = ev.id || ev.orderId;
//                             if (orderId) {
//                                 buf.orders.push({
//                                     ...ev,
//                                     id: orderId,
//                                     status: ev.status,
//                                     filledQty: ev.filledQty || 0,
//                                     remainingQty: ev.remainingQty,
//                                 });
//                                 buf.hasUpdates = true;
//                             }

//                             if (ev.status === 'REJECTED') {
//                                 playRejectBuzz();
//                                 setRiskAlert({
//                                     message: `${ev.instrument} REJECT: ${ev.rejectReason || ev.reason || 'Risk check failed'}`,
//                                     timestamp: new Date().toLocaleTimeString(),
//                                 });
//                             }
//                             break;
//                         }

//                         case 'PIQ_UPDATE': {
//                             const piqData = msg.piq || msg.data;
//                             if (piqData && piqData.orderId) {
//                                 buf.piq.set(piqData.orderId, piqData);
//                                 buf.hasUpdates = true;
//                             }
//                             break;
//                         }

//                         case 'POSITION_UPDATE': {
//                             const pos = msg.data || msg.position;
//                             if (pos && pos.instrument) {
//                                 buf.positions.set(pos.instrument, pos);
//                                 buf.hasUpdates = true;
//                             }
//                             break;
//                         }

//                         case 'RISK_EVENT': {
//                             playRejectBuzz();
//                             const r = msg.data || msg;
//                             setRiskAlert({
//                                 message: `RISK ALERT (${r.instrument}): ${r.reason} - ${r.message}`,
//                                 timestamp: new Date().toLocaleTimeString(),
//                             });
//                             break;
//                         }

//                         case 'CANCELLED':
//                             buf.orders.push({
//                                 id: msg.orderId,
//                                 instrument: msg.instrument,
//                                 status: 'CANCELLED',
//                                 updatedAt: new Date().toISOString(),
//                             });
//                             buf.hasUpdates = true;
//                             break;

//                         default:
//                             break;
//                     }
//                 } catch (err) {
//                     console.error('[WS] Failed parsing frame:', err);
//                 }
//             };

//             ws.onclose = () => {
//                 if (!isMounted) return;
//                 setIsConnected(false);
//                 setIsReconnecting(true);
//                 const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 10000);
//                 reconnectTimeoutRef.current = setTimeout(() => {
//                     setReconnectAttempt((prev) => prev + 1);
//                     connect();
//                 }, delay);
//             };

//             ws.onerror = () => {
//                 ws.close();
//             };
//         };

//         connect();

//         return () => {
//             isMounted = false;
//             if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
//             if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
//             if (wsRef.current) wsRef.current.close();
//         };
//     }, [token, traderId, hydrateUserData]);

//     useEffect(() => {
//         if (isConnected && wsRef.current?.readyState === WebSocket.OPEN) {
//             activeSymbols.forEach((sym) => {
//                 hydrateMarketSnapshot(sym);
//                 wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `depth:${sym}` }));
//                 wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `trades:${sym}` }));
//                 wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `ticker:${sym}` }));
//             });
//         }
//     }, [activeSymbolsKey, isConnected, hydrateMarketSnapshot]);

//     return {
//         isConnected,
//         isReconnecting,
//         tickers,
//         depths,
//         recentTrades,
//         tradesBySymbol,
//         traderFills,
//         orders,
//         positions,
//         piqMap,
//         alertFills,
//         clearAlertFills,
//         riskAlert,
//         clearRiskAlert: () => setRiskAlert(null),
//         placeOrder,
//         cancelOrder,
//     };
// }

import { useEffect, useRef, useState, useCallback } from 'react';
import { INSTRUMENTS } from '../constants/instruments';
import type { DepthBook, PriceTicker } from '../types/instrument';
import type { Fill, FillAlertItem, Order, PIQData, Position, OrderSide } from '../types/order';
import { playFillChime, playRejectBuzz } from '../utils/audio';

interface UseWebSocketOptions {
    token: string | null;
    traderId: string | null;
    activeSymbols: string[];
    onFillReceived?: (fill: FillAlertItem) => void;
    onLimitAlertReceived?: (req: any) => void;
    onLimitsUpdated?: (data: any) => void;
    onMarketModeChanged?: (mode: string) => void;
}

interface MutableMessageBuffer {
    prices: Map<string, PriceTicker>;
    depths: Map<string, DepthBook>;
    incomingTrades: Fill[];
    tradesBySymbol: Map<string, Fill[]>;
    traderFills: Fill[];
    orders: Partial<Order>[];
    piq: Map<string, PIQData>;
    positions: Map<string, Position>;
    alertFills: FillAlertItem[];
    hasUpdates: boolean;
}

export function useWebSocket({
    token,
    traderId,
    activeSymbols,
    onFillReceived,
    onLimitAlertReceived,
    onLimitsUpdated,
    onMarketModeChanged
}: UseWebSocketOptions) {
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
    const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);

    const [tickers, setTickers] = useState<Record<string, PriceTicker>>({});
    const [depths, setDepths] = useState<Record<string, DepthBook>>({});
    const [recentTrades, setRecentTrades] = useState<Fill[]>([]);
    const [tradesBySymbol, setTradesBySymbol] = useState<Record<string, Fill[]>>({});
    const [traderFills, setTraderFills] = useState<Fill[]>(() => {
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
    const [orders, setOrders] = useState<Order[]>([]);
    const [positions, setPositions] = useState<Position[]>([]);
    const [piqMap, setPiqMap] = useState<Record<string, PIQData>>({});
    const [alertFills, setAlertFills] = useState<FillAlertItem[]>([]);
    const [riskAlert, setRiskAlert] = useState<{ message: string; timestamp: string } | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<any>(null);
    const pingIntervalRef = useRef<any>(null);
    const rafIdRef = useRef<number | null>(null);
    const onFillReceivedRef = useRef(onFillReceived);
    onFillReceivedRef.current = onFillReceived;
    const onLimitAlertReceivedRef = useRef(onLimitAlertReceived);
    onLimitAlertReceivedRef.current = onLimitAlertReceived;
    const onLimitsUpdatedRef = useRef(onLimitsUpdated);
    onLimitsUpdatedRef.current = onLimitsUpdated;
    const onMarketModeChangedRef = useRef(onMarketModeChanged);
    onMarketModeChangedRef.current = onMarketModeChanged;

    const seenFillIdsRef = useRef<Set<string>>(new Set());
    const tickerCacheRef = useRef<Map<string, PriceTicker>>(new Map());

    const bufferRef = useRef<MutableMessageBuffer>({
        prices: new Map(),
        depths: new Map(),
        incomingTrades: [],
        tradesBySymbol: new Map(),
        traderFills: (() => {
            try {
                const key = traderId ? `oi_trader_fills_${traderId}` : 'oi_trader_fills_default';
                const saved = localStorage.getItem(key);
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed)) return parsed;
                }
            } catch {}
            return [];
        })(),
        orders: [],
        piq: new Map(),
        positions: new Map(),
        alertFills: [],
        hasUpdates: false,
    });

    // 1. Initial Market Snapshot & Historical Time & Sales (TAS) + Stats Hydration
    const hydrateMarketSnapshot = useCallback(async (symbol: string) => {
        try {
            const depthPromise = fetch(`/api/market/depth/${encodeURIComponent(symbol)}`);
            const tapePromise = fetch(`/api/market/tape/${encodeURIComponent(symbol)}?limit=200`);
            const statsPromise = fetch(`/api/market/stats/${encodeURIComponent(symbol)}`);

            const [depthRes, tapeRes, statsRes] = await Promise.allSettled([depthPromise, tapePromise, statsPromise]);

            let initialVolume = 0;
            let initialHigh: number | undefined;
            let initialLow: number | undefined;
            let initialOpen: number | undefined;
            let initialLast: number | undefined;

            if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
                const statsData = await statsRes.value.json();
                initialVolume = parseInt(statsData.volume, 10) || 0;
                if (statsData.high > 0) initialHigh = Number(statsData.high);
                if (statsData.low > 0) initialLow = Number(statsData.low);
                if (statsData.open > 0) initialOpen = Number(statsData.open);
                if (statsData.last > 0) initialLast = Number(statsData.last);
            }

            let bestBid = 0;
            let bestAsk = 0;
            let midPrice = 0;

            if (depthRes.status === 'fulfilled' && depthRes.value.ok) {
                const bookData = await depthRes.value.json();
                const depthSnapshot: DepthBook = {
                    instrument: symbol,
                    bids: bookData.bids || [],
                    asks: bookData.asks || [],
                    timestamp: new Date().toISOString(),
                };

                setDepths((prev) => ({
                    ...prev,
                    [symbol]: depthSnapshot,
                }));

                bestBid = bookData.bids?.[0]?.price ?? bookData.bestBid ?? 0;
                bestAsk = bookData.asks?.[0]?.price ?? bookData.bestAsk ?? 0;
                midPrice = bestBid && bestAsk ? Number(((bestBid + bestAsk) / 2).toFixed(2)) : bestBid || bestAsk;
            }

            let latestTradePrice: number | undefined;
            let latestTradeQty: number | undefined;

            if (tapeRes.status === 'fulfilled' && tapeRes.value.ok) {
                const rawTrades = await tapeRes.value.json();
                if (Array.isArray(rawTrades) && rawTrades.length > 0) {
                    const historicalTrades: Fill[] = rawTrades.map((t: any) => {
                        const rawSide = t.side || t.aggressorSide || t.aggressor_side || 'BUY';
                        const side: OrderSide = String(rawSide).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

                        return {
                            id: t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`,
                            orderId: t.orderId || '',
                            buyerId: t.buyerId || '',
                            sellerId: t.sellerId || '',
                            instrument: t.instrument || symbol,
                            side: side,
                            price: Number(t.price),
                            qty: Number(t.qty),
                            time: t.time || new Date().toISOString(),
                            aggressorSide: side,
                        };
                    });

                    historicalTrades.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
                    const latestTrade = historicalTrades[0];
                    if (latestTrade) {
                        latestTradePrice = latestTrade.price;
                        latestTradeQty = latestTrade.qty;
                    }

                    const buf = bufferRef.current;
                    const existing = buf.tradesBySymbol.get(symbol) || [];

                    const seenKeys = new Set<string>();
                    const merged: Fill[] = [];

                    for (const t of existing) {
                        const key = t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`;
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            merged.push(t);
                        }
                    }
                    for (const t of historicalTrades) {
                        const key = t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`;
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            merged.push(t);
                        }
                    }

                    merged.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
                    const final200 = merged.slice(0, 200);

                    buf.tradesBySymbol.set(symbol, final200);
                    buf.hasUpdates = true;
                }
            }

            const initialTicker: PriceTicker = {
                instrument: symbol,
                bid: bestBid,
                ask: bestAsk,
                last: initialLast || latestTradePrice || midPrice,
                lastQty: latestTradeQty,
                volume: initialVolume,
                high: initialHigh || latestTradePrice,
                low: initialLow || latestTradePrice,
                open: initialOpen,
                timestamp: new Date().toISOString(),
            };

            tickerCacheRef.current.set(symbol, initialTicker);

            setTickers((prev) => ({
                ...prev,
                [symbol]: initialTicker,
            }));
        } catch (err) {
            console.warn(`[Hydration] Failed snapshot for ${symbol}:`, err);
        }
    }, []);

    // 2. Initial User Data & Full Historical Fill Book Hydration
    const hydrateUserData = useCallback(async (authToken: string) => {
        try {
            const queryParams = traderId ? `?traderId=${encodeURIComponent(traderId)}` : '';

            // Reset buffers so previous trader's residual data is never merged in RAF loop
            bufferRef.current.orders = [];
            bufferRef.current.positions.clear();
            bufferRef.current.traderFills = [];

            // A. Hydrate Positions
            const posRes = await fetch(`/api/trading/positions${queryParams}`, {
                headers: { Authorization: `Bearer ${authToken}` },
            });
            if (posRes.ok) {
                const posData: Position[] = await posRes.json();
                setPositions(posData);
                posData.forEach((p) => bufferRef.current.positions.set(p.instrument, p));
            }

            // B. Hydrate Active & Historical Orders
            const ordRes = await fetch(`/api/trading/orders${queryParams}`, {
                headers: { Authorization: `Bearer ${authToken}` },
            });
            if (ordRes.ok) {
                const ordData: any[] = await ordRes.json();
                const normalizedOrders: Order[] = ordData.map((o) => ({
                    id: o.id,
                    traderId: o.traderId || o.trader_id || traderId || '',
                    instrument: o.instrument,
                    side: o.side,
                    type: o.type || 'LIMIT',
                    price: Number(o.price),
                    qty: Number(o.qty),
                    filledQty: Number(o.filledQty ?? o.filled_qty ?? 0),
                    remainingQty: Number(o.remainingQty ?? (o.qty - (o.filledQty ?? o.filled_qty ?? 0))),
                    status: o.status,
                    tif: o.tif || 'DAY',
                    createdAt: o.createdAt || o.created_at || new Date().toISOString(),
                    updatedAt: o.updatedAt || o.updated_at || o.createdAt || new Date().toISOString(),
                }));
                setOrders(normalizedOrders);
            }

            // C. Hydrate ALL Trader Historical Fills from Database
            const fillsRes = await fetch(`/api/trading/trades${queryParams}`, {
                headers: { Authorization: `Bearer ${authToken}` },
            });
            if (fillsRes.ok) {
                const fillsData: Fill[] = await fillsRes.json();
                const sortedFills: Fill[] = fillsData.map((f: any) => {
                    const rawSide = f.side || f.userSide || f.user_side || (f.buyerId === traderId ? 'BUY' : f.sellerId === traderId ? 'SELL' : 'BUY');
                    const side: OrderSide = String(rawSide).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

                    return {
                        id: f.id,
                        orderId: f.orderId || '',
                        buyerId: f.buyerId || '',
                        sellerId: f.sellerId || '',
                        instrument: f.instrument,
                        side,
                        price: Number(f.price),
                        qty: Number(f.qty),
                        time: f.time || new Date().toISOString(),
                        aggressorSide: f.aggressorSide || side,
                    };
                });

                sortedFills.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

                setTraderFills(sortedFills);
                bufferRef.current.traderFills = [...sortedFills];
                if (traderId) {
                    try {
                        localStorage.setItem(`oi_trader_fills_${traderId}`, JSON.stringify(sortedFills));
                    } catch {}
                }

                const initialAlertFills: FillAlertItem[] = sortedFills.map((f) => {
                    const meta = INSTRUMENTS[f.instrument];
                    return {
                        id: `fill_init_${f.id}`,
                        transactTime: f.time,
                        exchange: meta?.exchange || 'CME',
                        contract: f.instrument,
                        side: f.side,
                        filledQty: f.qty,
                        price: f.price,
                        exeQty: f.qty,
                        orderId: f.orderId,
                        notional: f.qty * f.price * (meta?.multiplier || 1),
                        account: traderId || undefined,
                    };
                });
                initialAlertFills.forEach((af) => seenFillIdsRef.current.add(af.id));
                setAlertFills(initialAlertFills);
            }
        } catch (err) {
            console.warn('[Hydration] Failed user data hydration:', err);
        }
    }, [traderId]);

    // 3. High-Frequency Throttled RAF Batch Flush Loop (30-60 FPS)
    useEffect(() => {
        let lastFlushTime = 0;

        const flushBatch = (timestamp: number) => {
            const buf = bufferRef.current;

            if (buf.hasUpdates && timestamp - lastFlushTime >= 33) {
                lastFlushTime = timestamp;

                if (buf.prices.size > 0) {
                    const pricesToFlush = new Map(buf.prices);
                    buf.prices.clear();
                    setTickers((prev) => {
                        const next = { ...prev };
                        pricesToFlush.forEach((ticker, sym) => {
                            next[sym] = ticker;
                        });
                        return next;
                    });
                }

                if (buf.depths.size > 0) {
                    const depthsToFlush = new Map(buf.depths);
                    buf.depths.clear();
                    setDepths((prev) => {
                        const next = { ...prev };
                        depthsToFlush.forEach((depth, sym) => {
                            next[sym] = depth;
                        });
                        return next;
                    });
                }

                // Flush Time & Sales incoming trades
                if (buf.incomingTrades.length > 0) {
                    const tradesToFlush = [...buf.incomingTrades];
                    buf.incomingTrades = [];

                    for (const t of tradesToFlush) {
                        const sym = t.instrument;
                        const currentList = buf.tradesBySymbol.get(sym) || [];
                        const key = t.id || `${t.time}_${t.instrument}_${t.price}_${t.qty}`;

                        const isDuplicate = currentList.some(
                            (item) => (item.id && item.id === t.id) || `${item.time}_${item.instrument}_${item.price}_${item.qty}` === key
                        );

                        if (!isDuplicate) {
                            const updated = [t, ...currentList];
                            updated.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
                            buf.tradesBySymbol.set(sym, updated.slice(0, 200));
                        }
                    }
                }

                const nextTradesBySymbol: Record<string, Fill[]> = {};
                const allRecent: Fill[] = [];

                buf.tradesBySymbol.forEach((list, sym) => {
                    nextTradesBySymbol[sym] = list;
                    allRecent.push(...list);
                });

                allRecent.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

                setTradesBySymbol(nextTradesBySymbol);
                setRecentTrades(allRecent.slice(0, 500));

                // Flush Trader Fills (Fill Book)
                if (buf.traderFills.length > 0) {
                    setTraderFills([...buf.traderFills]);
                }

                if (buf.orders.length > 0) {
                    const ordersToFlush = [...buf.orders];
                    buf.orders = [];
                    setOrders((prev) => {
                        const orderMap = new Map(prev.map((o) => [o.id, o]));
                        ordersToFlush.forEach((newOrder) => {
                            const oid = newOrder.id || (newOrder as any).orderId;
                            if (!oid) return;
                            const existing = orderMap.get(oid);
                            if (existing) {
                                const safeType = (newOrder.type && String(newOrder.type) !== 'ORDER_EVENT') ? newOrder.type : existing.type;
                                orderMap.set(oid, { ...existing, ...newOrder, type: safeType, id: oid } as Order);
                            } else {
                                const safeType = (newOrder.type && String(newOrder.type) !== 'ORDER_EVENT') ? newOrder.type : 'LIMIT';
                                orderMap.set(oid, { ...newOrder, type: safeType, id: oid } as Order);
                            }
                        });
                        return Array.from(orderMap.values());
                    });
                }

                if (buf.piq.size > 0) {
                    const piqToFlush = new Map(buf.piq);
                    buf.piq.clear();
                    setPiqMap((prev) => {
                        const next = { ...prev };
                        piqToFlush.forEach((data, orderId) => {
                            next[orderId] = data;
                        });
                        return next;
                    });
                }

                if (buf.positions.size > 0) {
                    const posToFlush = new Map(buf.positions);
                    buf.positions.clear();
                    setPositions((prev) => {
                        const posMap = new Map(prev.map((p) => [p.instrument, p]));
                        posToFlush.forEach((p, inst) => {
                            posMap.set(inst, p);
                        });
                        return Array.from(posMap.values());
                    });
                }

                if (buf.alertFills.length > 0) {
                    const fillsToFlush = [...buf.alertFills];
                    buf.alertFills = [];
                    setAlertFills((prev) => {
                        const seen = new Set<string>();
                        const combined = [...fillsToFlush, ...prev];
                        const unique: FillAlertItem[] = [];
                        for (const f of combined) {
                            if (!seen.has(f.id)) {
                                seen.add(f.id);
                                unique.push(f);
                            }
                        }
                        return unique.slice(0, 300);
                    });
                }

                buf.hasUpdates = false;
            }

            rafIdRef.current = requestAnimationFrame(flushBatch);
        };

        rafIdRef.current = requestAnimationFrame(flushBatch);
        return () => {
            if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
        };
    }, []);

    const sendAction = useCallback((action: any) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(action));
            return true;
        }
        return false;
    }, []);

    const placeOrder = useCallback(
        (params: {
            instrument: string;
            side: 'BUY' | 'SELL';
            type: 'LIMIT' | 'MARKET';
            price: number;
            qty: number;
            tif: 'DAY' | 'GTC' | 'IOC' | 'FOK';
        }) => {
            return sendAction({ action: 'PLACE_ORDER', ...params });
        },
        [sendAction]
    );

    const cancelOrder = useCallback(
        (orderId: string, instrument: string) => {
            setOrders((prev) =>
                prev.map((o) => (o.id === orderId ? { ...o, status: 'CANCELLING' } : o))
            );
            return sendAction({ action: 'CANCEL_ORDER', orderId, instrument });
        },
        [sendAction]
    );

    const clearAlertFills = useCallback(() => {
        setAlertFills([]);
    }, []);

    const activeSymbolsKey = activeSymbols.slice().sort().join(',');

    // 4. WebSocket Ingestion & Connection
    useEffect(() => {
        if (!token) return;

        let isMounted = true;

        activeSymbols.forEach((sym) => hydrateMarketSnapshot(sym));
        hydrateUserData(token);

        const connect = () => {
            if (wsRef.current?.readyState === WebSocket.OPEN) return;

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsHost = (window.location.port === '5173' || window.location.port === '3000')
                ? `${window.location.hostname}:4006`
                : window.location.host;
            const wsUrl = `${protocol}//${wsHost}/ws?token=${token}`;

            console.log(`[WS] Connecting to ${wsUrl}...`);
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                if (!isMounted) return;
                console.log('[WS] Connected successfully.');
                setIsConnected(true);
                setIsReconnecting(false);
                setReconnectAttempt(0);

                activeSymbols.forEach((sym) => {
                    ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `depth:${sym}` }));
                    ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `trades:${sym}` }));
                    ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `ticker:${sym}` }));
                });
                if (traderId) {
                    ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `trader:${traderId}` }));
                    ws.send(JSON.stringify({ action: 'SUBSCRIBE', room: `piq:${traderId}` }));
                }

                if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
                pingIntervalRef.current = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ action: 'PING', timestamp: Date.now() }));
                    }
                }, 10000);
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    const buf = bufferRef.current;

                    switch (msg.type) {
                        case 'PRICE_TICK':
                        case 'PRICE_UPDATE': {
                            const prevCached = tickerCacheRef.current.get(msg.instrument);
                            const msgVol = Number(msg.volume || 0);
                            const updatedVol = Math.max(msgVol, prevCached?.volume || 0);

                            const updatedTicker: PriceTicker = {
                                instrument: msg.instrument,
                                bid: Number(msg.bid || msg.bestBid || prevCached?.bid || 0),
                                ask: Number(msg.ask || msg.bestAsk || prevCached?.ask || 0),
                                last: Number(msg.last || prevCached?.last || 0),
                                lastQty: msg.lastQty !== undefined ? Number(msg.lastQty) : prevCached?.lastQty,
                                high: msg.high !== undefined ? Number(msg.high) : prevCached?.high,
                                low: msg.low !== undefined ? Number(msg.low) : prevCached?.low,
                                open: msg.open !== undefined ? Number(msg.open) : prevCached?.open,
                                volume: updatedVol,
                                timestamp: msg.timestamp || new Date().toISOString(),
                            };

                            tickerCacheRef.current.set(msg.instrument, updatedTicker);
                            buf.prices.set(msg.instrument, updatedTicker);
                            buf.hasUpdates = true;
                            break;
                        }

                        case 'DEPTH_UPDATE':
                        case 'BOOK_DEPTH': {
                            const depth: DepthBook = {
                                instrument: msg.instrument,
                                bids: msg.bids || [],
                                asks: msg.asks || [],
                                timestamp: msg.timestamp || new Date().toISOString(),
                            };
                            buf.depths.set(msg.instrument, depth);
                            buf.hasUpdates = true;
                            break;
                        }

                        case 'TRADE_TICK':
                        case 'TRADE': {
                            const trade = msg.trade || msg.data;
                            if (trade) {
                                const side: OrderSide = (trade.aggressorSide || trade.side || 'BUY') as OrderSide;
                                const tradePrice = Number(trade.price);
                                const tradeQty = Number(trade.qty);
                                const formattedTrade: Fill = {
                                    id: trade.id || trade.tradeId || `${trade.time}_${trade.instrument}_${trade.price}_${trade.qty}`,
                                    orderId: trade.buyOrderId || trade.sellOrderId || trade.orderId || '',
                                    buyerId: trade.buyerId || '',
                                    sellerId: trade.sellerId || '',
                                    instrument: trade.instrument,
                                    side: side,
                                    price: tradePrice,
                                    qty: tradeQty,
                                    time: trade.time || trade.timestamp || new Date().toISOString(),
                                    aggressorSide: side,
                                };

                                buf.incomingTrades.push(formattedTrade);

                                // If this trade belongs to currently active trader, also append to traderFills
                                if (traderId && (trade.buyerId === traderId || trade.sellerId === traderId)) {
                                    const traderSide: OrderSide = trade.buyerId === traderId ? 'BUY' : 'SELL';
                                    const myFill: Fill = {
                                        ...formattedTrade,
                                        side: traderSide,
                                        orderId: traderSide === 'BUY' ? (trade.buyOrderId || trade.orderId) : (trade.sellOrderId || trade.orderId),
                                    };
                                    const existing = buf.traderFills;
                                    const isDup = existing.some(
                                        (f) => (f.id && f.id === myFill.id) || `${f.time}_${f.instrument}_${f.price}_${f.qty}` === `${myFill.time}_${myFill.instrument}_${myFill.price}_${myFill.qty}`
                                    );
                                    if (!isDup) {
                                        const updated = [myFill, ...existing];
                                        buf.traderFills = updated;
                                        buf.hasUpdates = true;
                                        try {
                                            localStorage.setItem(`oi_trader_fills_${traderId}`, JSON.stringify(updated.slice(0, 200)));
                                        } catch {}
                                    }
                                }

                                // Persistent cache cumulative volume increment
                                const prevCached = tickerCacheRef.current.get(trade.instrument);
                                const updatedVol = (prevCached?.volume || 0) + tradeQty;
                                const updatedTicker: PriceTicker = {
                                    instrument: trade.instrument,
                                    bid: prevCached?.bid || 0,
                                    ask: prevCached?.ask || 0,
                                    last: tradePrice,
                                    lastQty: tradeQty,
                                    volume: updatedVol,
                                    high: prevCached?.high ? Math.max(prevCached.high, tradePrice) : tradePrice,
                                    low: prevCached?.low ? Math.min(prevCached.low, tradePrice) : tradePrice,
                                    open: prevCached?.open,
                                    timestamp: formattedTrade.time,
                                };

                                tickerCacheRef.current.set(trade.instrument, updatedTicker);
                                buf.prices.set(trade.instrument, updatedTicker);
                                buf.hasUpdates = true;
                            }
                            break;
                        }

                        case 'EXECUTION_FILL': {
                            playFillChime();
                            const trade = msg.trade || msg.data;
                            if (trade) {
                                const side: OrderSide = (msg.side || (trade.buyerId === traderId ? 'BUY' : 'SELL')) as OrderSide;
                                const fillId = trade.id || `fill_${Date.now()}_${Math.random()}`;
                                const tradePrice = Number(trade.price);
                                const tradeQty = Number(trade.qty);

                                const newTraderFill: Fill = {
                                    id: fillId,
                                    orderId: side === 'BUY' ? trade.buyOrderId : trade.sellOrderId,
                                    buyerId: trade.buyerId,
                                    sellerId: trade.sellerId,
                                    instrument: trade.instrument,
                                    side,
                                    price: tradePrice,
                                    qty: tradeQty,
                                    time: trade.time || trade.timestamp || new Date().toISOString(),
                                    aggressorSide: trade.aggressorSide || side,
                                };

                                const existingFills = buf.traderFills;
                                const isDup = existingFills.some(
                                    (f) => (f.id && f.id === fillId) || `${f.time}_${f.instrument}_${f.price}_${f.qty}` === `${newTraderFill.time}_${newTraderFill.instrument}_${newTraderFill.price}_${newTraderFill.qty}`
                                );

                                if (!isDup) {
                                    const updated = [newTraderFill, ...existingFills];
                                    buf.traderFills = updated;
                                    buf.hasUpdates = true;
                                    if (traderId) {
                                        try {
                                            localStorage.setItem(`oi_trader_fills_${traderId}`, JSON.stringify(updated.slice(0, 200)));
                                        } catch {}
                                    }
                                }

                                const prevCached = tickerCacheRef.current.get(trade.instrument);
                                const updatedTicker: PriceTicker = {
                                    instrument: trade.instrument,
                                    bid: prevCached?.bid || 0,
                                    ask: prevCached?.ask || 0,
                                    last: tradePrice,
                                    lastQty: tradeQty,
                                    volume: prevCached?.volume || 0,
                                    high: prevCached?.high ? Math.max(prevCached.high, tradePrice) : tradePrice,
                                    low: prevCached?.low ? Math.min(prevCached.low, tradePrice) : tradePrice,
                                    open: prevCached?.open,
                                    timestamp: newTraderFill.time,
                                };

                                tickerCacheRef.current.set(trade.instrument, updatedTicker);
                                buf.prices.set(trade.instrument, updatedTicker);
                                buf.hasUpdates = true;

                                if (!seenFillIdsRef.current.has(fillId)) {
                                    seenFillIdsRef.current.add(fillId);
                                    const meta = INSTRUMENTS[trade.instrument];
                                    const fillAlert: FillAlertItem = {
                                        id: fillId,
                                        transactTime: trade.time || trade.timestamp || new Date().toISOString(),
                                        exchange: meta?.exchange || 'CME',
                                        contract: trade.instrument,
                                        side,
                                        filledQty: tradeQty,
                                        price: tradePrice,
                                        exeQty: tradeQty,
                                        orderId: side === 'BUY' ? trade.buyOrderId : trade.sellOrderId,
                                        notional: tradeQty * tradePrice * (meta?.multiplier || 1),
                                        account: traderId || undefined,
                                    };
                                    buf.alertFills.unshift(fillAlert);
                                    buf.hasUpdates = true;
                                    if (onFillReceivedRef.current) {
                                        onFillReceivedRef.current(fillAlert);
                                    }
                                }
                            }
                            break;
                        }

                        case 'ORDER_SUBMITTED':
                            buf.orders.push({
                                id: msg.orderId,
                                instrument: msg.instrument,
                                side: msg.side,
                                price: msg.price,
                                qty: msg.qty,
                                filledQty: 0,
                                remainingQty: msg.qty,
                                status: 'SUBMITTED',
                                createdAt: msg.timestamp,
                                updatedAt: msg.timestamp,
                            });
                            buf.hasUpdates = true;
                            break;

                        case 'ORDER_EVENT': {
                            const ev = msg.event || msg;
                            const orderId = ev.id || ev.orderId;
                            if (orderId) {
                                const resolvedType = ev.orderType || ev.order_type || (ev.type !== 'ORDER_EVENT' ? ev.type : undefined);
                                buf.orders.push({
                                    ...ev,
                                    id: orderId,
                                    ...(resolvedType ? { type: resolvedType } : {}),
                                    status: ev.status,
                                    filledQty: ev.filledQty || 0,
                                    remainingQty: ev.remainingQty,
                                });
                                buf.hasUpdates = true;
                            }

                            if (ev.status === 'REJECTED') {
                                playRejectBuzz();
                                setRiskAlert({
                                    message: `${ev.instrument} REJECT: ${ev.rejectReason || ev.reason || 'Risk check failed'}`,
                                    timestamp: new Date().toLocaleTimeString(),
                                });
                            }
                            break;
                        }

                        case 'PIQ_UPDATE': {
                            const piqData = msg.piq || msg.data;
                            if (piqData && piqData.orderId) {
                                buf.piq.set(piqData.orderId, piqData);
                                buf.hasUpdates = true;
                            }
                            break;
                        }

                        case 'POSITION_UPDATE': {
                            const pos = msg.data || msg.position;
                            if (pos && pos.instrument) {
                                buf.positions.set(pos.instrument, pos);
                                buf.hasUpdates = true;
                            }
                            break;
                        }

                        case 'RISK_EVENT': {
                            playRejectBuzz();
                            const r = msg.data || msg;
                            setRiskAlert({
                                message: `RISK ALERT (${r.instrument}): ${r.reason} - ${r.message}`,
                                timestamp: new Date().toLocaleTimeString(),
                            });
                            break;
                        }

                        case 'CANCELLED':
                            buf.orders.push({
                                id: msg.orderId,
                                instrument: msg.instrument,
                                status: 'CANCELLED',
                                updatedAt: new Date().toISOString(),
                            });
                            buf.hasUpdates = true;
                            break;

                        case 'LIMIT_REQUEST_ALERT': {
                            const alertReq = msg.request || msg.data;
                            if (alertReq && onLimitAlertReceivedRef.current) {
                                onLimitAlertReceivedRef.current(alertReq);
                            }
                            break;
                        }

                        case 'LIMITS_UPDATED': {
                            if (onLimitsUpdatedRef.current) {
                                onLimitsUpdatedRef.current(msg);
                            }
                            break;
                        }

                        case 'MARKET_MODE_CHANGED': {
                            const newMode = msg.mode;
                            if (newMode && onMarketModeChangedRef.current) {
                                onMarketModeChangedRef.current(newMode);
                            }
                            break;
                        }

                        default:
                            break;
                    }
                } catch (err) {
                    console.error('[WS] Failed parsing frame:', err);
                }
            };

            ws.onclose = () => {
                if (!isMounted) return;
                setIsConnected(false);
                setIsReconnecting(true);
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 10000);
                reconnectTimeoutRef.current = setTimeout(() => {
                    setReconnectAttempt((prev) => prev + 1);
                    connect();
                }, delay);
            };

            ws.onerror = () => {
                ws.close();
            };
        };

        connect();

        return () => {
            isMounted = false;
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            if (wsRef.current) wsRef.current.close();
        };
    }, [token, traderId, hydrateUserData]);

    useEffect(() => {
        if (isConnected && wsRef.current?.readyState === WebSocket.OPEN) {
            activeSymbols.forEach((sym) => {
                hydrateMarketSnapshot(sym);
                wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `depth:${sym}` }));
                wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `trades:${sym}` }));
                wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `ticker:${sym}` }));
            });
            if (traderId) {
                wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `trader:${traderId}` }));
                wsRef.current?.send(JSON.stringify({ action: 'SUBSCRIBE', room: `piq:${traderId}` }));
            }
        }
    }, [activeSymbolsKey, isConnected, traderId, hydrateMarketSnapshot]);

    return {
        isConnected,
        isReconnecting,
        tickers,
        depths,
        recentTrades,
        tradesBySymbol,
        traderFills,
        orders,
        positions,
        piqMap,
        alertFills,
        clearAlertFills,
        riskAlert,
        clearRiskAlert: () => setRiskAlert(null),
        placeOrder,
        cancelOrder,
    };
}