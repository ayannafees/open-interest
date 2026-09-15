import React, { useEffect, useRef, useState } from 'react';
import {
    createChart,
    ColorType,
    CandlestickSeries,
    AreaSeries,
    type IChartApi,
    type ISeriesApi,
    type UTCTimestamp,
    type CandlestickData,
    type AreaData,
} from 'lightweight-charts';
import { INSTRUMENTS } from '../constants/instruments';
import type { Fill } from '../types/order';

interface ChartWidgetProps {
    instrument: string;
    recentTrades: Fill[];
}

type TimeframeOption = '1s' | '5s' | '1m' | '5m' | '15m';
type ChartStyleOption = 'CANDLES' | 'AREA';

export const ChartWidget: React.FC<ChartWidgetProps> = ({ instrument, recentTrades }) => {
    const [timeframe, setTimeframe] = useState<TimeframeOption>('1s');
    const [chartType, setChartType] = useState<ChartStyleOption>('CANDLES');

    const chartContainerRef = useRef<HTMLDivElement | null>(null);
    const chartApiRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);

    const currentCandleRef = useRef<CandlestickData<UTCTimestamp> | null>(null);
    const lastCandleTimeRef = useRef<number>(0);
    const lastTradedPriceRef = useRef<number>(INSTRUMENTS[instrument]?.defaultPrice || 2640.0);
    const lastProcessedTradeIdRef = useRef<string | null>(null);
    const isChartReadyRef = useRef<boolean>(false);

    const config = INSTRUMENTS[instrument] || {
        name: instrument,
        tickSize: 0.1,
        decimals: 2,
        defaultPrice: 2640.0,
        multiplier: 100,
    };

    // 1. Initialize Lightweight Charts
    useEffect(() => {
        if (!chartContainerRef.current) return;

        isChartReadyRef.current = false;
        currentCandleRef.current = null;
        lastCandleTimeRef.current = 0;
        lastProcessedTradeIdRef.current = null;

        if (chartApiRef.current) {
            chartApiRef.current.remove();
            chartApiRef.current = null;
            seriesRef.current = null;
        }

        const container = chartContainerRef.current;

        const chart = createChart(container, {
            layout: {
                background: { type: ColorType.Solid, color: '#f8fafc' },
                textColor: '#334155',
            },
            grid: {
                vertLines: { color: '#e2e8f0' },
                horzLines: { color: '#e2e8f0' },
            },
            crosshair: {
                vertLine: { color: '#1d70b8', width: 1, style: 2 },
                horzLine: { color: '#1d70b8', width: 1, style: 2 },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: timeframe === '1s' || timeframe === '5s',
                borderColor: '#cbd5e1',
            },
            rightPriceScale: {
                borderColor: '#cbd5e1',
            },
            width: container.clientWidth,
            height: container.clientHeight || 240,
        });

        chartApiRef.current = chart;

        let series: ISeriesApi<'Candlestick'> | ISeriesApi<'Area'>;
        if (chartType === 'CANDLES') {
            series = chart.addSeries(CandlestickSeries, {
                upColor: '#16a34a',
                downColor: '#dc2626',
                borderUpColor: '#16a34a',
                borderDownColor: '#dc2626',
                wickUpColor: '#16a34a',
                wickDownColor: '#dc2626',
                priceFormat: {
                    type: 'price',
                    precision: config.decimals,
                    minMove: config.tickSize,
                },
            });
        } else {
            series = chart.addSeries(AreaSeries, {
                topColor: 'rgba(29, 112, 184, 0.35)',
                bottomColor: 'rgba(29, 112, 184, 0.02)',
                lineColor: '#1d70b8',
                lineWidth: 2,
                priceFormat: {
                    type: 'price',
                    precision: config.decimals,
                    minMove: config.tickSize,
                },
            });
        }
        seriesRef.current = series;

        const loadCandleHistory = async () => {
            try {
                const intervalSec =
                    timeframe === '1s' ? 1 : timeframe === '5s' ? 5 : timeframe === '1m' ? 60 : timeframe === '5m' ? 300 : 900;
                const nowSec = Math.floor(Date.now() / 1000);
                const alignedNow = (Math.floor(nowSec / intervalSec) * intervalSec) as UTCTimestamp;

                let candleData: CandlestickData<UTCTimestamp>[] = [];

                try {
                    const res = await fetch(
                        `/api/market/candles/${encodeURIComponent(instrument)}?timeframe=${timeframe}&limit=100`
                    );
                    if (res.ok) {
                        const json = await res.json();
                        if (Array.isArray(json.candles) && json.candles.length > 0) {
                            candleData = json.candles.map((c: any) => ({
                                time: (Math.floor(c.time / intervalSec) * intervalSec) as UTCTimestamp,
                                open: Number(c.open),
                                high: Number(c.high),
                                low: Number(c.low),
                                close: Number(c.close),
                            }));
                        }
                    }
                } catch { }

                if (candleData.length === 0) {
                    const ltp = lastTradedPriceRef.current || config.defaultPrice;
                    for (let i = 30; i >= 0; i--) {
                        const t = (alignedNow - i * intervalSec) as UTCTimestamp;
                        candleData.push({ time: t, open: ltp, high: ltp, low: ltp, close: ltp });
                    }
                }

                if (chartType === 'CANDLES') {
                    (series as ISeriesApi<'Candlestick'>).setData(candleData);
                } else {
                    const areaData: AreaData<UTCTimestamp>[] = candleData.map((c) => ({
                        time: c.time,
                        value: c.close,
                    }));
                    (series as ISeriesApi<'Area'>).setData(areaData);
                }

                if (candleData.length > 0) {
                    const lastBar = candleData[candleData.length - 1];
                    currentCandleRef.current = { ...lastBar };
                    lastCandleTimeRef.current = lastBar.time as number;
                    lastTradedPriceRef.current = lastBar.close;
                }

                isChartReadyRef.current = true;
                chart.timeScale().fitContent();
            } catch (err) {
                console.warn('[Chart History Failed]', err);
            }
        };

        loadCandleHistory();

        const resizeObserver = new ResizeObserver((entries) => {
            if (!entries || entries.length === 0) return;
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        });
        resizeObserver.observe(container);

        return () => {
            isChartReadyRef.current = false;
            resizeObserver.disconnect();
            chart.remove();
            chartApiRef.current = null;
            seriesRef.current = null;
        };
    }, [instrument, timeframe, chartType, config.decimals, config.tickSize]);

    // 2. Real-Time Trade-Driven Ingestion
    useEffect(() => {
        if (!isChartReadyRef.current || !seriesRef.current || recentTrades.length === 0) return;

        const matchingTrades = recentTrades.filter((t) => t.instrument === instrument);
        if (matchingTrades.length === 0) return;

        const latestTrade = matchingTrades[0];
        const tradeKey = latestTrade.id || `${latestTrade.time}_${latestTrade.price}_${latestTrade.qty}`;
        if (lastProcessedTradeIdRef.current === tradeKey) return;
        lastProcessedTradeIdRef.current = tradeKey;

        const tradePrice = typeof latestTrade.price === 'number' ? latestTrade.price : parseFloat(latestTrade.price);
        lastTradedPriceRef.current = tradePrice;

        const intervalSec =
            timeframe === '1s' ? 1 : timeframe === '5s' ? 5 : timeframe === '1m' ? 60 : timeframe === '5m' ? 300 : 900;
        const nowSec = Math.floor(Date.now() / 1000);
        let bucketTime = (Math.floor(nowSec / intervalSec) * intervalSec) as UTCTimestamp;

        if ((bucketTime as number) < lastCandleTimeRef.current) {
            bucketTime = lastCandleTimeRef.current as UTCTimestamp;
        }

        try {
            if (currentCandleRef.current && currentCandleRef.current.time === bucketTime) {
                const candle = currentCandleRef.current;
                candle.high = Math.max(candle.high, tradePrice);
                candle.low = Math.min(candle.low, tradePrice);
                candle.close = tradePrice;

                if (chartType === 'CANDLES') {
                    (seriesRef.current as ISeriesApi<'Candlestick'>).update(candle);
                } else {
                    (seriesRef.current as ISeriesApi<'Area'>).update({ time: candle.time, value: candle.close });
                }
            } else {
                const newCandle: CandlestickData<UTCTimestamp> = {
                    time: bucketTime,
                    open: tradePrice,
                    high: tradePrice,
                    low: tradePrice,
                    close: tradePrice,
                };
                currentCandleRef.current = newCandle;
                lastCandleTimeRef.current = bucketTime as number;

                if (chartType === 'CANDLES') {
                    (seriesRef.current as ISeriesApi<'Candlestick'>).update(newCandle);
                } else {
                    (seriesRef.current as ISeriesApi<'Area'>).update({ time: bucketTime, value: tradePrice });
                }
            }
        } catch (err) {
            console.warn('[Trade Chart Update Ignored]', err);
        }
    }, [recentTrades, instrument, timeframe, chartType]);

    // 3. Zero-Trade Flatline Generator
    useEffect(() => {
        if (!isChartReadyRef.current || !seriesRef.current) return;

        const intervalSec =
            timeframe === '1s' ? 1 : timeframe === '5s' ? 5 : timeframe === '1m' ? 60 : timeframe === '5m' ? 300 : 900;

        const flatlineTimer = setInterval(() => {
            if (!isChartReadyRef.current || !seriesRef.current) return;

            const nowSec = Math.floor(Date.now() / 1000);
            const currentBucketTime = (Math.floor(nowSec / intervalSec) * intervalSec) as UTCTimestamp;

            if (!currentCandleRef.current || (currentBucketTime as number) > (currentCandleRef.current.time as number)) {
                const ltp = lastTradedPriceRef.current || config.defaultPrice;

                const flatCandle: CandlestickData<UTCTimestamp> = {
                    time: currentBucketTime,
                    open: ltp,
                    high: ltp,
                    low: ltp,
                    close: ltp,
                };

                currentCandleRef.current = flatCandle;
                lastCandleTimeRef.current = currentBucketTime as number;

                try {
                    if (chartType === 'CANDLES') {
                        (seriesRef.current as ISeriesApi<'Candlestick'>).update(flatCandle);
                    } else {
                        (seriesRef.current as ISeriesApi<'Area'>).update({ time: currentBucketTime, value: ltp });
                    }
                } catch (err) {
                    console.warn('[Flatline Update Ignored]', err);
                }
            }
        }, 1000);

        return () => clearInterval(flatlineTimer);
    }, [timeframe, chartType, config.defaultPrice]);

    return (
        <div className="w-full h-full flex flex-col gap-2 font-mono select-none">
            {/* Chart Control Bar */}
            <div className="flex items-center justify-between bg-[#e2e6eb] p-1.5 rounded border border-[#b4bcc8] shrink-0 text-xs shadow-sm">
                <div className="flex items-center gap-2">
                    <span className="text-slate-600 text-[10px] uppercase font-bold">LTP:</span>
                    <span className="font-black text-slate-900 text-sm">
                        {lastTradedPriceRef.current.toFixed(config.decimals)}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {/* Timeframe selector */}
                    <div className="flex items-center bg-white p-0.5 rounded border border-[#b4bcc8] shadow-sm">
                        {(['1s', '5s', '1m', '5m', '15m'] as const).map((tf) => (
                            <button
                                key={tf}
                                type="button"
                                onClick={() => setTimeframe(tf)}
                                className={`px-2 py-0.5 text-[10px] font-bold rounded transition ${timeframe === tf
                                    ? 'bg-slate-800 text-white shadow-sm'
                                    : 'text-slate-600 hover:text-slate-900'
                                    }`}
                            >
                                {tf}
                            </button>
                        ))}
                    </div>

                    {/* Style selector */}
                    <div className="flex items-center bg-white p-0.5 rounded border border-[#b4bcc8] shadow-sm">
                        <button
                            type="button"
                            onClick={() => setChartType('CANDLES')}
                            className={`px-2 py-0.5 text-[10px] font-bold rounded transition ${chartType === 'CANDLES'
                                ? 'bg-slate-800 text-white shadow-sm'
                                : 'text-slate-600 hover:text-slate-900'
                                }`}
                        >
                            Candles
                        </button>
                        <button
                            type="button"
                            onClick={() => setChartType('AREA')}
                            className={`px-2 py-0.5 text-[10px] font-bold rounded transition ${chartType === 'AREA'
                                ? 'bg-slate-800 text-white shadow-sm'
                                : 'text-slate-600 hover:text-slate-900'
                                }`}
                        >
                            Area
                        </button>
                    </div>
                </div>
            </div>

            {/* Chart Canvas */}
            <div
                ref={chartContainerRef}
                className="flex-1 w-full relative rounded overflow-hidden bg-[#f8fafc] border border-[#b4bcc8] shadow-inner"
            />
        </div>
    );
};