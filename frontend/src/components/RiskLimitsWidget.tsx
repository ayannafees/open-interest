import React, { useState, useEffect, useCallback } from 'react';
import {
    ShieldAlert,
    Save,
    Sparkles,
    Lock,
    Unlock,
    CheckCircle2,
    Send,
    Inbox,
    Clock,
    Check,
    X,
    MessageSquare,
    Layers,
    ListFilter
} from 'lucide-react';
import { INSTRUMENTS, INSTRUMENT_SYMBOLS } from '../constants/instruments';
import type { Position } from '../types/order';

interface RiskLimitsWidgetProps {
    traderId: string | null;
    role?: string;
    positions: Position[];
    initialTab?: 'LIMITS' | 'REQUEST_FORM' | 'REQUESTS_QUEUE';
    liveLimitsUpdate?: { traderId: string; limits: any[]; timestamp: string } | null;
}

export interface ContractRiskLimit {
    maxOrderQty: number;
    maxPosition: number;
    maxNotional: number;
    tradeAllowed: boolean;
}

export interface LimitRequestItem {
    id: string;
    traderId: string;
    username?: string;
    instrument: string;
    reqMaxOrderQty: number;
    reqMaxPosition: number;
    reqMaxNotional: number;
    reason: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    createdAt: string;
    reviewedAt?: string;
    reviewedBy?: string;
    adminComment?: string;
}

const STORAGE_LIMITS_KEY = 'oi_trader_risk_limits';

export const RiskLimitsWidget: React.FC<RiskLimitsWidgetProps> = ({
    traderId,
    role = 'TRADER',
    positions,
    initialTab,
    liveLimitsUpdate
}) => {
    const isAdmin = role === 'ADMIN';

    // Default zero limits (Zero-Trust)
    const defaultZeroLimits: Record<string, ContractRiskLimit> = {
        'GC Dec27': { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: false },
        'CL Dec27': { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: false },
        'SR3 Dec27': { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: false },
        'CRA Dec27': { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: false },
        'ER3 Jun26': { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: false },
    };

    const [limitsMap, setLimitsMap] = useState<Record<string, ContractRiskLimit>>(() => {
        try {
            const saved = localStorage.getItem(`${STORAGE_LIMITS_KEY}_${traderId || 'default'}`);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch { }
        return defaultZeroLimits;
    });

    // Active View Tab
    const [activeTab, setActiveTab] = useState<'LIMITS' | 'REQUEST_FORM' | 'REQUESTS_QUEUE'>(initialTab || 'LIMITS');

    useEffect(() => {
        if (initialTab) {
            setActiveTab(initialTab);
        }
    }, [initialTab]);

    // Admin Limit Config Form Inputs
    const [selectedTarget, setSelectedTarget] = useState<string>('GC Dec27');
    const [applyToAll, setApplyToAll] = useState<boolean>(false);
    const [formMaxOrderQty, setFormMaxOrderQty] = useState<number>(0);
    const [formMaxPosition, setFormMaxPosition] = useState<number>(0);
    const [formMaxNotional, setFormMaxNotional] = useState<number>(0);
    const [formTradeAllowed, setFormTradeAllowed] = useState<boolean>(false);
    const [saveSuccess, setSaveSuccess] = useState<boolean>(false);

    // Trader Limit Request Form Inputs
    const [reqTarget, setReqTarget] = useState<string>('GC Dec27');
    const [reqOrderQty, setReqOrderQty] = useState<number>(50);
    const [reqPosition, setReqPosition] = useState<number>(100);
    const [reqNotional, setReqNotional] = useState<number>(5000000);
    const [reqReason, setReqReason] = useState<string>('');
    const [isSubmittingReq, setIsSubmittingReq] = useState<boolean>(false);
    const [reqFeedback, setReqFeedback] = useState<{ type: 'SUCCESS' | 'ERROR'; msg: string } | null>(null);

    // Limit Requests List (Trader: my requests; Admin: all requests)
    const [requestsList, setRequestsList] = useState<LimitRequestItem[]>([]);
    const [reviewComments, setReviewComments] = useState<Record<string, string>>({});
    const [isReviewingId, setIsReviewingId] = useState<string | null>(null);

    // Fetch active limits from backend
    const fetchActiveLimits = useCallback(async () => {
        const token = localStorage.getItem('oi_token');
        if (!token) return;

        try {
            const endpoint = isAdmin && traderId
                ? `/api/admin/limits/${encodeURIComponent(traderId)}`
                : `/api/trading/limits${isAdmin && traderId ? `?traderId=${encodeURIComponent(traderId)}` : ''}`;

            const res = await fetch(endpoint, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.limits)) {
                    setLimitsMap((prev) => {
                        const next = { ...prev };
                        data.limits.forEach((lim: any) => {
                            if (lim.instrument) {
                                next[lim.instrument] = {
                                    maxOrderQty: Number(lim.maxOrderQty) || 0,
                                    maxPosition: Number(lim.maxPosition) || 0,
                                    maxNotional: Number(lim.maxNotional) || 0,
                                    tradeAllowed: Boolean(lim.tradeAllowed),
                                };
                            }
                        });
                        try {
                            localStorage.setItem(
                                `${STORAGE_LIMITS_KEY}_${traderId || 'default'}`,
                                JSON.stringify(next)
                            );
                        } catch { }
                        return next;
                    });
                }
            }
        } catch { }
    }, [isAdmin, traderId]);

    // Fetch live requests from AppServer
    const fetchRequests = useCallback(async () => {
        const token = localStorage.getItem('oi_token');
        if (!token) return;

        try {
            const endpoint = isAdmin ? '/api/admin/limit-requests' : '/api/trading/limit-requests';
            const res = await fetch(endpoint, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.ok) {
                const data = await res.json();
                setRequestsList(data);
            }
        } catch { }
    }, [isAdmin]);

    // Fetch limits and requests on mount and on trader change
    useEffect(() => {
        fetchActiveLimits();
        fetchRequests();
        const interval = setInterval(() => {
            fetchRequests();
            fetchActiveLimits();
        }, 10000);
        return () => clearInterval(interval);
    }, [fetchActiveLimits, fetchRequests]);

    // Real-Time WebSocket live limits update listener
    useEffect(() => {
        if (!liveLimitsUpdate) return;
        if (!traderId || liveLimitsUpdate.traderId === traderId) {
            if (Array.isArray(liveLimitsUpdate.limits)) {
                setLimitsMap((prev) => {
                    const next = { ...prev };
                    liveLimitsUpdate.limits.forEach((lim: any) => {
                        if (lim.instrument) {
                            next[lim.instrument] = {
                                maxOrderQty: Number(lim.maxOrderQty) || 0,
                                maxPosition: Number(lim.maxPosition) || 0,
                                maxNotional: Number(lim.maxNotional) || 0,
                                tradeAllowed: Boolean(lim.tradeAllowed),
                            };
                        }
                    });
                    try {
                        localStorage.setItem(
                            `${STORAGE_LIMITS_KEY}_${traderId || 'default'}`,
                            JSON.stringify(next)
                        );
                    } catch { }
                    return next;
                });
            }
        }
    }, [liveLimitsUpdate, traderId]);

    // Load current values when selecting a different instrument
    useEffect(() => {
        if (selectedTarget && limitsMap[selectedTarget]) {
            const cur = limitsMap[selectedTarget];
            setFormMaxOrderQty(cur.maxOrderQty);
            setFormMaxPosition(cur.maxPosition);
            setFormMaxNotional(cur.maxNotional);
            setFormTradeAllowed(cur.tradeAllowed);
        }
    }, [selectedTarget, limitsMap]);

    // Admin: Save Limits directly
    const handleSaveLimits = async () => {
        const targetsToUpdate = applyToAll ? INSTRUMENT_SYMBOLS : [selectedTarget];

        const nextMap = { ...limitsMap };
        targetsToUpdate.forEach((sym) => {
            nextMap[sym] = {
                maxOrderQty: Math.max(0, formMaxOrderQty),
                maxPosition: Math.max(0, formMaxPosition),
                maxNotional: Math.max(0, formMaxNotional),
                tradeAllowed: formTradeAllowed && formMaxOrderQty > 0 && formMaxPosition > 0 && formMaxNotional > 0,
            };
        });

        setLimitsMap(nextMap);

        try {
            localStorage.setItem(
                `${STORAGE_LIMITS_KEY}_${traderId || 'default'}`,
                JSON.stringify(nextMap)
            );

            const token = localStorage.getItem('oi_token');
            if (token) {
                for (const sym of targetsToUpdate) {
                    await fetch('/api/admin/limits', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                            traderId: traderId || 'trader1',
                            instrument: sym,
                            maxOrderQty: nextMap[sym].maxOrderQty,
                            maxPosition: nextMap[sym].maxPosition,
                            maxNotional: nextMap[sym].maxNotional,
                            tradeAllowed: nextMap[sym].tradeAllowed,
                        }),
                    }).catch(() => { });
                }
            }
        } catch { }

        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2500);
    };

    // Trader: Submit Limit Increase Request
    const handleSubmitLimitRequest = async (e: React.FormEvent) => {
        e.preventDefault();
        setReqFeedback(null);
        setIsSubmittingReq(true);

        const token = localStorage.getItem('oi_token');
        if (!token) {
            setReqFeedback({ type: 'ERROR', msg: 'You must be logged in to submit a request' });
            setIsSubmittingReq(false);
            return;
        }

        try {
            const res = await fetch('/api/trading/limit-requests', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    instrument: reqTarget,
                    reqMaxOrderQty: reqOrderQty,
                    reqMaxPosition: reqPosition,
                    reqMaxNotional: reqNotional,
                    reason: reqReason.trim() || 'Institutional trader capacity expansion',
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                setReqFeedback({ type: 'ERROR', msg: data.error || 'Request submission failed' });
                setIsSubmittingReq(false);
                return;
            }

            setReqFeedback({ type: 'SUCCESS', msg: `Request #${data.request.id} submitted for review!` });
            setReqReason('');
            fetchRequests();
            setTimeout(() => {
                setActiveTab('REQUESTS_QUEUE');
                setReqFeedback(null);
            }, 1200);
        } catch (err: any) {
            setReqFeedback({ type: 'ERROR', msg: err.message || 'Network error' });
        } finally {
            setIsSubmittingReq(false);
        }
    };

    // Admin: Review Request (Approve or Reject)
    const handleReviewRequest = async (requestId: string, action: 'APPROVE' | 'REJECT') => {
        const token = localStorage.getItem('oi_token');
        if (!token) return;

        setIsReviewingId(requestId);
        try {
            const comment = reviewComments[requestId] || '';
            const res = await fetch(`/api/admin/limit-requests/${requestId}/review`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ action, adminComment: comment }),
            });

            if (res.ok) {
                fetchRequests();
                fetchActiveLimits();
            }
        } catch { }
        finally {
            setIsReviewingId(null);
        }
    };

    // Quick Preset Handlers
    const handleApplyPreset = (tier: 'ZERO' | 'RETAIL' | 'INSTITUTIONAL') => {
        let orderQty = 0;
        let pos = 0;
        let notional = 0;
        let allowed = false;

        if (tier === 'RETAIL') {
            orderQty = 10;
            pos = 20;
            notional = 1000000;
            allowed = true;
        } else if (tier === 'INSTITUTIONAL') {
            orderQty = 100;
            pos = 200;
            notional = 10000000;
            allowed = true;
        }

        setFormMaxOrderQty(orderQty);
        setFormMaxPosition(pos);
        setFormMaxNotional(notional);
        setFormTradeAllowed(allowed);
    };

    const handleResetAllToZero = () => {
        setLimitsMap(defaultZeroLimits);
        setFormMaxOrderQty(0);
        setFormMaxPosition(0);
        setFormMaxNotional(0);
        setFormTradeAllowed(false);
        try {
            localStorage.setItem(
                `${STORAGE_LIMITS_KEY}_${traderId || 'default'}`,
                JSON.stringify(defaultZeroLimits)
            );
        } catch { }
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
    };

    const posMap = new Map<string, Position>();
    positions.forEach((p) => posMap.set(p.instrument, p));

    const pendingRequestsCount = requestsList.filter((r) => r.status === 'PENDING').length;

    return (
        <div className="w-full h-full flex flex-col gap-2.5 text-xs overflow-y-auto pr-1 select-none font-mono">
            {/* 1. Header Banner */}
            <div className="bg-[#e2e6eb] p-2.5 rounded border border-[#b4bcc8] flex items-center justify-between shrink-0 shadow-sm">
                <div className="flex items-center gap-2">
                    <ShieldAlert size={16} className={isAdmin ? 'text-purple-700' : 'text-amber-700'} />
                    <div>
                        <div className="text-[11px] font-black text-slate-900 flex items-center gap-1.5">
                            <span>ROM PRE-TRADE FIREWALL</span>
                            <span className={`text-[9px] px-1.5 py-0.2 rounded border font-black uppercase ${isAdmin
                                ? 'bg-purple-100 text-purple-900 border-purple-300'
                                : 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                }`}>
                                {role}
                            </span>
                        </div>
                        <div className="text-[10px] text-slate-600">
                            Active Trader: <b className="text-slate-900">{traderId || 'trader1'}</b>
                        </div>
                    </div>
                </div>

                {saveSuccess && (
                    <div className="flex items-center gap-1 text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded border border-emerald-300 text-[10px] font-bold animate-pulse shadow-sm">
                        <CheckCircle2 size={12} />
                        <span>Limits Applied!</span>
                    </div>
                )}
            </div>

            {/* 2. Navigation Tabs */}
            <div className="grid grid-cols-3 gap-1 bg-[#e2e6eb] p-1 rounded-lg border border-[#b4bcc8] shrink-0 text-[11px] font-bold shadow-sm">
                <button
                    onClick={() => setActiveTab('LIMITS')}
                    className={`py-1.5 px-2 rounded flex items-center justify-center gap-1.5 transition ${activeTab === 'LIMITS'
                        ? 'bg-white text-slate-900 border border-[#b4bcc8] shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                        }`}
                >
                    <Layers size={13} />
                    <span>{isAdmin ? 'Admin Controls' : 'Active Limits'}</span>
                </button>

                {!isAdmin ? (
                    <button
                        onClick={() => setActiveTab('REQUEST_FORM')}
                        className={`py-1.5 px-2 rounded flex items-center justify-center gap-1.5 transition ${activeTab === 'REQUEST_FORM'
                            ? 'bg-white text-slate-900 border border-[#b4bcc8] shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <Send size={13} />
                        <span>Request Increase</span>
                    </button>
                ) : (
                    <button
                        onClick={() => setActiveTab('REQUESTS_QUEUE')}
                        className={`py-1.5 px-2 rounded flex items-center justify-center gap-1.5 transition relative ${activeTab === 'REQUESTS_QUEUE'
                            ? 'bg-white text-purple-900 border border-purple-300 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <Inbox size={13} />
                        <span>Review Queue</span>
                        {pendingRequestsCount > 0 && (
                            <span className="bg-amber-500 text-slate-900 text-[9px] font-black px-1.5 py-0.2 rounded-full">
                                {pendingRequestsCount}
                            </span>
                        )}
                    </button>
                )}

                <button
                    onClick={() => setActiveTab('REQUESTS_QUEUE')}
                    className={`py-1.5 px-2 rounded flex items-center justify-center gap-1.5 transition ${activeTab === 'REQUESTS_QUEUE' && !isAdmin
                        ? 'bg-white text-slate-900 border border-[#b4bcc8] shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                        }`}
                >
                    <ListFilter size={13} />
                    <span>{isAdmin ? 'All History' : 'My Requests'}</span>
                </button>
            </div>

            {/* TAB CONTENT 1: Active Limits & Admin Controls */}
            {activeTab === 'LIMITS' && (
                <>
                    {/* Admin Interactive Form (Only visible to Admin) */}
                    {isAdmin && (
                        <div className="bg-[#eef1f6] p-3 rounded-lg border border-[#b4bcc8] space-y-3 shrink-0 shadow-sm">
                            <div className="flex items-center justify-between border-b border-[#b4bcc8] pb-2">
                                <span className="text-[10px] font-bold text-purple-900 uppercase tracking-wider flex items-center gap-1">
                                    <span>👑 Admin Direct Override:</span>
                                    <b className="text-slate-900">{traderId || 'trader1'}</b>
                                </span>

                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => handleApplyPreset('RETAIL')}
                                        className="px-1.5 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-900 text-[9px] font-bold rounded border border-blue-300 transition shadow-sm"
                                    >
                                        Retail
                                    </button>
                                    <button
                                        onClick={() => handleApplyPreset('INSTITUTIONAL')}
                                        className="px-1.5 py-0.5 bg-purple-100 hover:bg-purple-200 text-purple-900 text-[9px] font-bold rounded border border-purple-300 transition shadow-sm"
                                    >
                                        Inst
                                    </button>
                                    <button
                                        onClick={handleResetAllToZero}
                                        className="px-1.5 py-0.5 bg-red-100 hover:bg-red-200 text-red-900 text-[9px] font-bold rounded border border-red-300 transition shadow-sm"
                                    >
                                        Lockdown 0
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[9px] text-slate-600 uppercase block font-bold mb-1">
                                        Target Contract:
                                    </label>
                                    <select
                                        value={selectedTarget}
                                        onChange={(e) => setSelectedTarget(e.target.value)}
                                        disabled={applyToAll}
                                        className="w-full bg-white border border-[#b4bcc8] rounded px-2 py-1 text-xs font-bold text-slate-900 outline-none cursor-pointer disabled:opacity-40 shadow-sm"
                                    >
                                        {INSTRUMENT_SYMBOLS.map((sym) => (
                                            <option key={sym} value={sym}>
                                                {sym} — {INSTRUMENTS[sym]?.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label className="text-[9px] text-slate-600 uppercase block font-bold mb-1">
                                        Scope:
                                    </label>
                                    <button
                                        onClick={() => setApplyToAll((prev) => !prev)}
                                        className={`w-full py-1 text-xs font-bold rounded border transition flex items-center justify-center gap-1.5 shadow-sm ${applyToAll
                                            ? 'bg-purple-700 text-white border-purple-800'
                                            : 'bg-white text-slate-700 border-[#b4bcc8]'
                                            }`}
                                    >
                                        <Sparkles size={12} />
                                        <span>{applyToAll ? 'ALL Contracts (Batch)' : 'Single Contract'}</span>
                                    </button>
                                </div>
                            </div>

                            {/* Inputs */}
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px]">
                                    <span className="text-slate-600 uppercase font-bold">Max Order Qty:</span>
                                    <span className="font-bold text-blue-800">{formMaxOrderQty} Lots</span>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    value={formMaxOrderQty}
                                    onChange={(e) => setFormMaxOrderQty(Math.max(0, parseInt(e.target.value) || 0))}
                                    className="w-full bg-white border border-[#b4bcc8] rounded px-2 py-1 text-center font-bold text-slate-900 text-sm outline-none focus:border-blue-600 shadow-inner"
                                />
                            </div>

                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px]">
                                    <span className="text-slate-600 uppercase font-bold">Max Net Position:</span>
                                    <span className="font-bold text-blue-800">{formMaxPosition} Lots</span>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    value={formMaxPosition}
                                    onChange={(e) => setFormMaxPosition(Math.max(0, parseInt(e.target.value) || 0))}
                                    className="w-full bg-white border border-[#b4bcc8] rounded px-2 py-1 text-center font-bold text-slate-900 text-sm outline-none focus:border-blue-600 shadow-inner"
                                />
                            </div>

                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[10px]">
                                    <span className="text-slate-600 uppercase font-bold">Max Notional ($ USD):</span>
                                    <span className="font-bold text-blue-800">${formMaxNotional.toLocaleString()}</span>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    step="100000"
                                    value={formMaxNotional}
                                    onChange={(e) => setFormMaxNotional(Math.max(0, parseFloat(e.target.value) || 0))}
                                    className="w-full bg-white border border-[#b4bcc8] rounded px-2 py-1 text-center font-bold text-slate-900 text-sm outline-none focus:border-blue-600 shadow-inner"
                                />
                            </div>

                            <div className="flex items-center justify-between pt-1">
                                <span className="text-[10px] text-slate-600 uppercase font-bold">
                                    Trading Permission:
                                </span>
                                <button
                                    onClick={() => setFormTradeAllowed((prev) => !prev)}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold transition shadow ${formTradeAllowed && formMaxOrderQty > 0
                                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                        : 'bg-red-600 hover:bg-red-700 text-white'
                                        }`}
                                >
                                    {formTradeAllowed && formMaxOrderQty > 0 ? (
                                        <>
                                            <Unlock size={12} />
                                            <span>TRADING ENABLED</span>
                                        </>
                                    ) : (
                                        <>
                                            <Lock size={12} />
                                            <span>LOCKED (BLOCKED)</span>
                                        </>
                                    )}
                                </button>
                            </div>

                            <button
                                onClick={handleSaveLimits}
                                className="w-full py-2 bg-[#1d70b8] hover:bg-[#155b96] text-white text-xs font-black rounded shadow transition active:scale-95 flex items-center justify-center gap-1.5"
                            >
                                <Save size={13} />
                                <span>SAVE & APPLY RISK LIMITS</span>
                            </button>
                        </div>
                    )}

                    {/* Live Contract Status Blotter */}
                    <div className="space-y-1.5 flex-1">
                        <div className="text-[10px] font-bold text-slate-600 uppercase flex items-center justify-between">
                            <span>Enforced Contract Limits & Live Utilization:</span>
                            {!isAdmin && (
                                <span className="text-[9px] text-slate-500 font-semibold">Read-Only (Protected)</span>
                            )}
                        </div>

                        <div className="space-y-1.5">
                            {INSTRUMENT_SYMBOLS.map((sym) => {
                                const lim = limitsMap[sym] || { maxOrderQty: 0, maxPosition: 0, maxNotional: 0, tradeAllowed: false };
                                const pos = posMap.get(sym);
                                const netPos = Math.abs(pos?.netPos || 0);
                                const isConfigured = lim.maxOrderQty > 0 && lim.maxPosition > 0 && lim.maxNotional > 0 && lim.tradeAllowed;

                                const posUtilPct =
                                    lim.maxPosition > 0 ? Math.min(100, Math.round((netPos / lim.maxPosition) * 100)) : 0;

                                return (
                                    <div
                                        key={sym}
                                        className="p-2 bg-white border border-[#b4bcc8] rounded flex flex-col gap-1 text-[11px] shadow-sm"
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-slate-900">{sym}</span>
                                                <span
                                                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${isConfigured
                                                        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                                        : 'bg-red-100 text-red-800 border-red-300'
                                                        }`}
                                                >
                                                    {isConfigured ? '✅ ACTIVE' : '🔒 0 LIMITS (BLOCKED)'}
                                                </span>
                                            </div>

                                            {isAdmin ? (
                                                <button
                                                    onClick={() => {
                                                        setSelectedTarget(sym);
                                                        setApplyToAll(false);
                                                    }}
                                                    className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded text-[9px] font-bold border border-[#b4bcc8] shadow-sm"
                                                >
                                                    Edit
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => {
                                                        setReqTarget(sym);
                                                        setActiveTab('REQUEST_FORM');
                                                    }}
                                                    className="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-800 rounded text-[9px] font-bold border border-blue-200 flex items-center gap-1 shadow-sm"
                                                >
                                                    <Send size={10} />
                                                    <span>Increase</span>
                                                </button>
                                            )}
                                        </div>

                                        <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-600 bg-slate-50 p-1 rounded border border-slate-200">
                                            <div>
                                                <span>Max Ord: </span>
                                                <b className="text-slate-900">{lim.maxOrderQty}</b>
                                            </div>
                                            <div>
                                                <span>Max Pos: </span>
                                                <b className="text-slate-900">{lim.maxPosition}</b>
                                            </div>
                                            <div>
                                                <span>Max Notional: </span>
                                                <b className="text-slate-900">
                                                    ${lim.maxNotional >= 1000000 ? `${lim.maxNotional / 1000000}M` : `${lim.maxNotional / 1000}K`}
                                                </b>
                                            </div>
                                        </div>

                                        {isConfigured && (
                                            <div className="space-y-0.5 pt-0.5">
                                                <div className="flex justify-between text-[9px] text-slate-600 font-semibold">
                                                    <span>Position Utilized: {netPos} / {lim.maxPosition} Lots</span>
                                                    <span>{posUtilPct}%</span>
                                                </div>
                                                <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden border border-slate-300">
                                                    <div
                                                        className={`h-full transition-all ${posUtilPct > 80 ? 'bg-red-600' : posUtilPct > 50 ? 'bg-amber-500' : 'bg-emerald-600'
                                                            }`}
                                                        style={{ width: `${Math.max(2, posUtilPct)}%` }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}

            {/* TAB CONTENT 2: Trader Request Limit Increase Form */}
            {activeTab === 'REQUEST_FORM' && !isAdmin && (
                <form onSubmit={handleSubmitLimitRequest} className="bg-white p-3 rounded-lg border border-[#b4bcc8] space-y-3 shrink-0 shadow-sm">
                    <div className="border-b border-[#b4bcc8] pb-2">
                        <div className="text-[11px] font-black text-slate-900 uppercase">
                            Submit Limit Increase Request
                        </div>
                        <div className="text-[10px] text-slate-600">
                            Requests are reviewed and approved by Platform Administrators.
                        </div>
                    </div>

                    {reqFeedback && (
                        <div className={`p-2 rounded border text-[10px] font-bold flex items-center gap-1.5 shadow-sm ${reqFeedback.type === 'SUCCESS'
                            ? 'bg-emerald-100 border-emerald-300 text-emerald-900'
                            : 'bg-red-100 border-red-300 text-red-900'
                            }`}>
                            {reqFeedback.type === 'SUCCESS' ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}
                            <span>{reqFeedback.msg}</span>
                        </div>
                    )}

                    <div>
                        <label className="text-[10px] text-slate-600 uppercase block font-bold mb-1">
                            Contract:
                        </label>
                        <select
                            value={reqTarget}
                            onChange={(e) => setReqTarget(e.target.value)}
                            className="w-full bg-slate-50 border border-[#b4bcc8] rounded px-2 py-1.5 text-xs font-bold text-slate-900 outline-none cursor-pointer shadow-inner"
                        >
                            {INSTRUMENT_SYMBOLS.map((sym) => (
                                <option key={sym} value={sym}>
                                    {sym} — {INSTRUMENTS[sym]?.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[10px] text-slate-600 uppercase block font-bold mb-1">
                                Desired Max Order Qty:
                            </label>
                            <input
                                type="number"
                                min="1"
                                value={reqOrderQty}
                                onChange={(e) => setReqOrderQty(Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full bg-slate-50 border border-[#b4bcc8] rounded px-2 py-1 text-center font-bold text-slate-900 outline-none focus:border-blue-600 shadow-inner"
                                required
                            />
                        </div>

                        <div>
                            <label className="text-[10px] text-slate-600 uppercase block font-bold mb-1">
                                Desired Max Net Position:
                            </label>
                            <input
                                type="number"
                                min="1"
                                value={reqPosition}
                                onChange={(e) => setReqPosition(Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full bg-slate-50 border border-[#b4bcc8] rounded px-2 py-1 text-center font-bold text-slate-900 outline-none focus:border-blue-600 shadow-inner"
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <div className="flex justify-between items-center text-[10px] mb-1">
                            <span className="text-slate-600 uppercase font-bold">
                                Desired Max Notional ($ USD):
                            </span>
                            <span className="font-bold text-blue-800">
                                ${reqNotional.toLocaleString()} ({reqNotional >= 1000000 ? `${(reqNotional / 1000000).toFixed(1)}M` : `${(reqNotional / 1000).toFixed(0)}K`})
                            </span>
                        </div>
                        <input
                            type="number"
                            min="1000000"
                            step="100000"
                            value={reqNotional}
                            onChange={(e) => setReqNotional(Math.max(1000000, parseFloat(e.target.value) || 1000000))}
                            className="w-full bg-slate-50 border border-[#b4bcc8] rounded px-2 py-1.5 text-center font-bold text-slate-900 outline-none focus:border-blue-600 shadow-inner"
                            required
                        />
                        <div className="grid grid-cols-5 gap-1 pt-1.5">
                            {[
                                { label: '$1M', val: 1000000 },
                                { label: '$5M', val: 5000000 },
                                { label: '$10M', val: 10000000 },
                                { label: '$25M', val: 25000000 },
                                { label: '$50M', val: 50000000 },
                            ].map((item) => (
                                <button
                                    key={item.label}
                                    type="button"
                                    onClick={() => setReqNotional(item.val)}
                                    className={`py-0.5 text-[9px] font-bold rounded border transition ${reqNotional === item.val
                                        ? 'bg-slate-800 text-white border-slate-900 shadow-sm'
                                        : 'bg-white text-slate-700 border-[#b4bcc8] hover:bg-slate-100'
                                        }`}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="text-[10px] text-slate-600 uppercase block font-bold mb-1">
                            Trading Rationale / Reason:
                        </label>
                        <textarea
                            value={reqReason}
                            onChange={(e) => setReqReason(e.target.value)}
                            placeholder="e.g. Higher volatility expected during FOMC release; increased inventory required"
                            rows={2}
                            className="w-full bg-slate-50 border border-[#b4bcc8] rounded p-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 resize-none shadow-inner"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={isSubmittingReq}
                        className="w-full py-2 bg-[#1d70b8] hover:bg-[#155b96] text-white text-xs font-black rounded shadow transition active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                        <Send size={13} />
                        <span>{isSubmittingReq ? 'SUBMITTING...' : 'TRANSMIT REQUEST TO ADMIN'}</span>
                    </button>
                </form>
            )}

            {/* TAB CONTENT 3: Requests History & Admin Review Queue */}
            {activeTab === 'REQUESTS_QUEUE' && (
                <div className="space-y-2 flex-1">
                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-600 uppercase border-b border-[#b4bcc8] pb-1">
                        <span>{isAdmin ? 'Institutional Review Pipeline' : 'My Limit Requests'}</span>
                        <button
                            onClick={fetchRequests}
                            className="text-blue-700 font-bold hover:underline text-[9px]"
                        >
                            Refresh
                        </button>
                    </div>

                    {requestsList.length === 0 ? (
                        <div className="p-6 text-center text-slate-500 bg-white rounded border border-[#b4bcc8] shadow-sm">
                            No limit increase requests found.
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {requestsList.map((req) => {
                                const isPending = req.status === 'PENDING';
                                const isApproved = req.status === 'APPROVED';
                                const isRejected = req.status === 'REJECTED';

                                return (
                                    <div
                                        key={req.id}
                                        className={`p-2.5 rounded border transition flex flex-col gap-1.5 shadow-sm ${isPending
                                            ? 'bg-amber-50/70 border-amber-300'
                                            : isApproved
                                                ? 'bg-emerald-50/70 border-emerald-300'
                                                : 'bg-red-50/70 border-red-300'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-1.5">
                                                <span className="font-bold text-slate-900">{req.instrument}</span>
                                                {isAdmin && req.username && (
                                                    <span className="bg-white px-1.5 py-0.2 rounded text-[9px] text-purple-900 font-bold border border-[#b4bcc8] shadow-sm">
                                                        👤 {req.username} ({req.traderId.slice(0, 8)})
                                                    </span>
                                                )}
                                            </div>

                                            <span
                                                className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase flex items-center gap-1 ${isPending
                                                    ? 'bg-amber-100 text-amber-900 border-amber-300'
                                                    : isApproved
                                                        ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                                        : 'bg-red-100 text-red-900 border-red-300'
                                                    }`}
                                            >
                                                {isPending && <Clock size={10} className="animate-spin text-amber-700" />}
                                                {isApproved && <Check size={10} className="text-emerald-700" />}
                                                {isRejected && <X size={10} className="text-red-700" />}
                                                <span>{req.status}</span>
                                            </span>
                                        </div>

                                        <div className="grid grid-cols-3 gap-1 text-[10px] text-slate-600 bg-white p-1.5 rounded border border-slate-200">
                                            <div>
                                                <span>Req Ord: </span>
                                                <b className="text-slate-900">{req.reqMaxOrderQty} Lots</b>
                                            </div>
                                            <div>
                                                <span>Req Pos: </span>
                                                <b className="text-slate-900">{req.reqMaxPosition} Lots</b>
                                            </div>
                                            <div>
                                                <span>Req Notional: </span>
                                                <b className="text-slate-900">${(req.reqMaxNotional / 1000000).toFixed(1)}M</b>
                                            </div>
                                        </div>

                                        {req.reason && (
                                            <div className="text-[10px] text-slate-600 italic flex items-center gap-1">
                                                <MessageSquare size={11} className="shrink-0" />
                                                <span>"{req.reason}"</span>
                                            </div>
                                        )}

                                        {req.adminComment && (
                                            <div className="text-[10px] text-purple-900 bg-purple-50 p-1 rounded border border-purple-200">
                                                <b>Admin Note:</b> {req.adminComment}
                                            </div>
                                        )}

                                        {/* Admin Action Bar (Only for PENDING requests) */}
                                        {isAdmin && isPending && (
                                            <div className="pt-1.5 border-t border-[#b4bcc8] flex flex-col gap-1.5">
                                                <input
                                                    type="text"
                                                    placeholder="Optional admin review comment..."
                                                    value={reviewComments[req.id] || ''}
                                                    onChange={(e) =>
                                                        setReviewComments({
                                                            ...reviewComments,
                                                            [req.id]: e.target.value,
                                                        })
                                                    }
                                                    className="w-full bg-white border border-[#b4bcc8] rounded px-2 py-0.5 text-[10px] text-slate-900 placeholder-slate-400 outline-none focus:border-purple-600 shadow-inner"
                                                />

                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleReviewRequest(req.id, 'APPROVE')}
                                                        disabled={isReviewingId === req.id}
                                                        className="flex-1 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-[10px] transition active:scale-95 flex items-center justify-center gap-1 shadow-sm"
                                                    >
                                                        <Check size={11} />
                                                        <span>APPROVE & SYNC LIMITS</span>
                                                    </button>
                                                    <button
                                                        onClick={() => handleReviewRequest(req.id, 'REJECT')}
                                                        disabled={isReviewingId === req.id}
                                                        className="flex-1 py-1 bg-red-600 hover:bg-red-700 text-white font-bold rounded text-[10px] transition active:scale-95 flex items-center justify-center gap-1 shadow-sm"
                                                    >
                                                        <X size={11} />
                                                        <span>REJECT</span>
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};