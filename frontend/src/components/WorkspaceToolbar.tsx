import React from 'react';
import {
    TrendingUp,
    Layers,
    FileSpreadsheet,
    ClipboardList,
    ListOrdered,
    Briefcase,
    Receipt,
    ShieldCheck,
    BellRing,
    LayoutGrid,
    Sparkles,
    Trash2,
    LogIn,
    LogOut,
    ShieldAlert,
    UserCheck,
    Radio,
    Bell
} from 'lucide-react';
import type { WidgetType } from '../types/window';

export interface TraderAccount {
    id: string;
    username: string;
    role: string;
}

interface WorkspaceToolbarProps {
    isConnected: boolean;
    isReconnecting: boolean;
    token: string | null;
    username: string;
    role: 'ADMIN' | 'TRADER' | string;
    traderId: string | null;
    availableTraders: TraderAccount[];
    activeTraderId: string | null;
    pendingLimitRequestsCount?: number;
    marketMode?: 'RANDOM_WALK' | 'USER_DRIVEN' | string;
    onSelectTrader: (traderId: string) => void;
    onOpenLimitRequests?: () => void;
    onChangeMarketMode?: (mode: 'RANDOM_WALK' | 'USER_DRIVEN') => void;
    onOpenAuthModal: () => void;
    onLogout: () => void;
    onSpawnWidget: (type: WidgetType) => void;
    onApplyScalperLayout: () => void;
    onApplyMultiContractLayout: () => void;
    onClearCanvas: () => void;
}

export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({
    isConnected,
    isReconnecting,
    token,
    username,
    role,
    traderId,
    availableTraders,
    activeTraderId,
    pendingLimitRequestsCount = 0,
    marketMode = 'RANDOM_WALK',
    onSelectTrader,
    onOpenLimitRequests,
    onChangeMarketMode,
    onOpenAuthModal,
    onLogout,
    onSpawnWidget,
    onApplyScalperLayout,
    onApplyMultiContractLayout,
    onClearCanvas,
}) => {
    const isAdmin = role === 'ADMIN';

    return (
        <header className="bg-[#d4d8df] border-b border-[#b4bcc8] px-4 py-1.5 flex flex-wrap items-center justify-between gap-3 select-none shrink-0 shadow-sm">
            {/* Brand & Connection Status */}
            <div className="flex items-center gap-3">
                <div className="flex flex-col justify-center">
                    <div className="flex items-center gap-2">
                        <span className="text-slate-900 font-black tracking-widest text-base leading-none">
                            OPEN INTEREST
                        </span>
                        <span className="bg-amber-100 text-amber-800 text-[10px] font-extrabold px-2 py-0.5 rounded border border-amber-300 uppercase tracking-wider leading-none">
                            MODULAR COCKPIT
                        </span>
                    </div>
                    <span className="text-[9px] font-black text-slate-600 uppercase tracking-wider mt-0.5">
                        REAL EXCHANGE AND TRADING PLATFORM CREATED BY AYAN NAFEES (NO REAL MONEY INVOLVED)
                    </span>
                </div>

                <div className="flex items-center gap-1.5 ml-2 pl-3 border-l border-[#b4bcc8]">
                    <span
                        className={`w-2.5 h-2.5 rounded-full ${isConnected
                            ? 'bg-emerald-600'
                            : isReconnecting
                                ? 'bg-amber-500 animate-ping'
                                : 'bg-red-600'
                            }`}
                    />
                    <span className="text-[11px] font-bold text-slate-800">
                        {isConnected ? 'LIVE (60 FPS)' : isReconnecting ? 'RECONNECTING...' : 'DISCONNECTED'}
                    </span>
                </div>
            </div>

            {/* Widget Spawners */}
            <div className="flex items-center gap-1 bg-[#e2e6eb] border border-[#b4bcc8] rounded p-0.5">
                <span className="text-[10px] font-bold text-slate-600 px-1.5 uppercase">
                    + Add:
                </span>
                <button
                    onClick={() => onSpawnWidget('CHART')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Independent Chart"
                >
                    <TrendingUp size={13} className="text-blue-600" />
                    <span>Chart</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('LADDER')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open 20-Level DOM Depth Ladder"
                >
                    <Layers size={13} className="text-emerald-700" />
                    <span>DOM Ladder</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('ORDER_TICKET')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Order Entry Ticket"
                >
                    <FileSpreadsheet size={13} className="text-amber-700" />
                    <span>Order Ticket</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('ORDER_BOOK')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Working Orders Book Blotter"
                >
                    <ClipboardList size={13} className="text-amber-700" />
                    <span>Order Book</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('TAS')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Time & Sales Tape"
                >
                    <ListOrdered size={13} className="text-cyan-700" />
                    <span>Tape (TAS)</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('POSITION_BOOK')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Position Book & P&L Blotter"
                >
                    <Briefcase size={13} className="text-purple-700" />
                    <span>Positions</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('FILL_BOOK')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Fills Execution Log"
                >
                    <Receipt size={13} className="text-pink-700" />
                    <span>Fills</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('FILL_ALERT')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-amber-100 hover:bg-amber-200 text-amber-900 text-xs font-bold rounded border border-amber-300 transition active:scale-95 shadow-sm"
                    title="Open Real-time Fill Alert Pop-up Window"
                >
                    <BellRing size={13} className="text-amber-700 animate-pulse" />
                    <span>Fill Alert</span>
                </button>
                <button
                    onClick={() => onSpawnWidget('LIMITS')}
                    className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                    title="Open Risk Firewall Controls"
                >
                    <ShieldCheck size={13} className="text-amber-700" />
                    <span>Risk Limits</span>
                </button>
            </div>

            {/* Quick Layout Presets, Admin Switcher & Auth Controls */}
            <div className="flex items-center gap-2">
                {/* Admin Mode Switcher & Limit Review Queue */}
                {isAdmin && (
                    <div className="flex items-center gap-1.5">
                        {/* MDS Mode Switcher */}
                        <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded border border-[#b4bcc8] text-xs shadow-sm">
                            <span className="text-[10px] font-bold text-slate-600 uppercase flex items-center gap-1">
                                <Radio size={11} className={marketMode === 'RANDOM_WALK' ? 'text-purple-600 animate-pulse' : 'text-amber-600'} />
                                <span>MDS:</span>
                            </span>
                            <div className="flex items-center bg-[#e2e6eb] rounded p-0.5 border border-[#b4bcc8]">
                                <button
                                    onClick={() => onChangeMarketMode?.('RANDOM_WALK')}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${marketMode === 'RANDOM_WALK'
                                        ? 'bg-purple-700 text-white shadow-sm'
                                        : 'text-slate-600 hover:text-slate-900'
                                        }`}
                                    title="Switch to Simulated Random Walk Market Data"
                                >
                                    Random Walk
                                </button>
                                <button
                                    onClick={() => onChangeMarketMode?.('USER_DRIVEN')}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold transition ${marketMode === 'USER_DRIVEN'
                                        ? 'bg-amber-700 text-white shadow-sm'
                                        : 'text-slate-600 hover:text-slate-900'
                                        }`}
                                    title="Switch to Pure User-Driven Orderbook Data"
                                >
                                    User-Driven
                                </button>
                            </div>
                        </div>

                        {/* Review Queue Alerts Badge */}
                        <button
                            onClick={onOpenLimitRequests}
                            className={`flex items-center gap-1 px-2 py-1 rounded border text-xs font-bold transition active:scale-95 shadow-sm ${pendingLimitRequestsCount > 0
                                ? 'bg-amber-100 text-amber-900 border-amber-400 animate-pulse'
                                : 'bg-white text-slate-700 border-[#b4bcc8] hover:bg-slate-100'
                                }`}
                            title="Open Limit Requests Review Queue"
                        >
                            <Bell size={12} className={pendingLimitRequestsCount > 0 ? 'text-amber-600' : 'text-slate-500'} />
                            <span>Limits Queue</span>
                            {pendingLimitRequestsCount > 0 && (
                                <span className="bg-amber-500 text-slate-900 text-[9px] font-black px-1.5 py-0.2 rounded-full">
                                    {pendingLimitRequestsCount}
                                </span>
                            )}
                        </button>
                    </div>
                )}

                <div className="flex items-center gap-1 bg-[#e2e6eb] p-0.5 rounded border border-[#b4bcc8]">
                    <button
                        onClick={onApplyScalperLayout}
                        className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-900 text-xs font-bold rounded border border-blue-300 transition active:scale-95 shadow-sm"
                        title="Load 1-Chart + DOM + Ticket + TAS Scalper Layout"
                    >
                        <Sparkles size={12} className="text-blue-700" />
                        <span>Scalper</span>
                    </button>
                    <button
                        onClick={onApplyMultiContractLayout}
                        className="flex items-center gap-1 px-2 py-0.5 bg-purple-100 hover:bg-purple-200 text-purple-900 text-xs font-bold rounded border border-purple-300 transition active:scale-95 shadow-sm"
                        title="Load Gold + Crude Oil Multi-Contract Trading Grid"
                    >
                        <LayoutGrid size={12} className="text-purple-700" />
                        <span>Multi-Sym</span>
                    </button>
                    <button
                        onClick={onClearCanvas}
                        className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-red-50 text-slate-700 hover:text-red-700 text-xs font-bold rounded border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                        title="Clear All Canvas Windows to Blank State"
                    >
                        <Trash2 size={12} />
                        <span>Clear</span>
                    </button>
                </div>

                {/* Authentication & Role-Based Account Control */}
                {!token ? (
                    <button
                        onClick={onOpenAuthModal}
                        className="flex items-center gap-1.5 px-3 py-1 bg-terminal-buy hover:bg-terminal-buy-hover text-white text-xs font-black rounded shadow-sm transition active:scale-95"
                    >
                        <LogIn size={13} />
                        <span>SIGN IN / REGISTER</span>
                    </button>
                ) : (
                    <div className="flex items-center gap-2 bg-white px-2.5 py-0.5 rounded border border-[#b4bcc8] text-xs shadow-sm">
                        {/* Role Indicator Pill */}
                        <span
                            className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase flex items-center gap-1 ${isAdmin
                                ? 'bg-purple-100 text-purple-900 border-purple-300'
                                : 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                }`}
                        >
                            {isAdmin ? <ShieldAlert size={10} className="text-purple-700" /> : <UserCheck size={10} className="text-emerald-700" />}
                            <span>{role}</span>
                        </span>

                        {/* ADMIN ONLY: Multi-Trader Account Selector */}
                        {isAdmin && availableTraders.length > 0 ? (
                            <div className="flex items-center gap-1.5 border-l border-[#b4bcc8] pl-2">
                                <span className="text-slate-600 text-[10px] font-semibold">View Trader:</span>
                                <select
                                    value={activeTraderId || traderId || ''}
                                    onChange={(e) => onSelectTrader(e.target.value)}
                                    className="bg-slate-50 border border-[#b4bcc8] rounded px-2 py-0.5 text-xs font-bold text-slate-900 outline-none cursor-pointer"
                                >
                                    {availableTraders.map((t) => (
                                        <option key={t.id} value={t.id}>
                                            {t.username} ({t.id.slice(0, 10)}) {t.role === 'ADMIN' ? '👑' : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        ) : (
                            /* TRADER: Fixed Display */
                            <div className="flex items-center gap-1">
                                <span className="text-slate-600">Account:</span>
                                <span className="text-slate-900 font-black">{username}</span>
                            </div>
                        )}

                        <button
                            onClick={onLogout}
                            className="text-slate-500 hover:text-red-700 text-[11px] ml-1 p-1 hover:bg-slate-100 rounded transition"
                            title="Sign Out / Switch Account"
                        >
                            <LogOut size={13} />
                        </button>
                    </div>
                )}
            </div>
        </header>
    );
};