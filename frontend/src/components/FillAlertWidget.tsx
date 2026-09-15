import React, { useState, useMemo } from 'react';
import {
    BellRing,
    Radio,
    Pause,
    Trash2,
    Filter,
    Search,
    ChevronDown,
    ArrowUpDown,
    CheckSquare,
    Square,
    Copy,
    Download,
    Eye,
} from 'lucide-react';
import { INSTRUMENTS, INSTRUMENT_SYMBOLS } from '../constants/instruments';
import type { FillAlertItem } from '../types/order';

interface FillAlertWidgetProps {
    fills: FillAlertItem[];
    onClear: () => void;
}

type ModeType = 'CONTINUOUS' | 'SNAPSHOT';
type SortField = 'transactTime' | 'exchange' | 'contract' | 'side' | 'filledQty' | 'price' | 'exeQty';
type SortDirection = 'asc' | 'desc';

interface ColumnConfig {
    key: string;
    label: string;
    sortKey?: SortField;
    visible: boolean;
    align?: 'left' | 'center' | 'right';
    minWidth?: string;
}

const VENUE_BADGE_STYLES: Record<string, string> = {
    COMEX: 'bg-amber-100 text-amber-900 border-amber-300',
    NYMEX: 'bg-orange-100 text-orange-900 border-orange-300',
    CME: 'bg-blue-100 text-blue-900 border-blue-300',
    MX: 'bg-emerald-100 text-emerald-900 border-emerald-300',
    ICE: 'bg-purple-100 text-purple-900 border-purple-300',
};

/**
 * Millisecond-precision ISO time formatter (e.g. 2026-09-14T16:22:28.174Z -> 16:22:28.174)
 */
function formatMsTime(isoString: string): string {
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return isoString;
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');
        const ms = String(date.getMilliseconds()).padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    } catch {
        return isoString;
    }
}

export const FillAlertWidget: React.FC<FillAlertWidgetProps> = ({ fills, onClear }) => {
    // 1. Mode State: Continuous (Live Append) vs Snapshot (Paused/Frozen)
    const [mode, setMode] = useState<ModeType>('CONTINUOUS');
    const [snapshotBuffer, setSnapshotBuffer] = useState<FillAlertItem[]>([]);
    const [selectedSymbol, setSelectedSymbol] = useState<string>('ALL');
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

    // 2. Sorting State (Default: Transact Time Descending ▼1)
    const [sortField, setSortField] = useState<SortField>('transactTime');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

    // 3. Right-Click Context Menu for Column Configurations
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; colKey: string } | null>(null);

    // 4. Column Definitions & Visibility State
    const [columns, setColumns] = useState<ColumnConfig[]>([
        { key: 'select', label: '☐', visible: true, align: 'center', minWidth: '32px' },
        { key: 'transactTime', label: 'Transact Time', sortKey: 'transactTime', visible: true, align: 'left', minWidth: '115px' },
        { key: 'exchange', label: 'Exch', sortKey: 'exchange', visible: true, align: 'center', minWidth: '60px' },
        { key: 'contract', label: 'Contract', sortKey: 'contract', visible: true, align: 'left', minWidth: '85px' },
        { key: 'side', label: 'Side', sortKey: 'side', visible: true, align: 'center', minWidth: '55px' },
        { key: 'filledQty', label: 'Filled', sortKey: 'filledQty', visible: true, align: 'right', minWidth: '55px' },
        { key: 'price', label: 'Price', sortKey: 'price', visible: true, align: 'right', minWidth: '75px' },
        { key: 'exeQty', label: 'ExeQty', sortKey: 'exeQty', visible: true, align: 'right', minWidth: '55px' },
        { key: 'orderId', label: 'Order ID', visible: true, align: 'left', minWidth: '90px' },
    ]);

    // When switching to Snapshot, lock the current view
    const handleToggleMode = (newMode: ModeType) => {
        if (newMode === 'SNAPSHOT' && mode === 'CONTINUOUS') {
            setSnapshotBuffer([...fills]);
        }
        setMode(newMode);
    };

    // Fills to display based on Continuous vs Snapshot
    const activeFillsList = mode === 'CONTINUOUS' ? fills : snapshotBuffer;

    // Number of pending fills arriving while in Snapshot mode
    const pendingCount = mode === 'SNAPSHOT' ? Math.max(0, fills.length - snapshotBuffer.length) : 0;

    const handleApplySnapshotPending = () => {
        setSnapshotBuffer([...fills]);
    };

    // 5. Filter & Sort Logic
    const processedFills = useMemo(() => {
        let list = [...activeFillsList];

        // Filter by Contract
        if (selectedSymbol !== 'ALL') {
            list = list.filter((f) => f.contract === selectedSymbol);
        }

        // Search Query filter
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(
                (f) =>
                    f.contract.toLowerCase().includes(q) ||
                    f.exchange.toLowerCase().includes(q) ||
                    f.side.toLowerCase().includes(q) ||
                    (f.orderId && f.orderId.toLowerCase().includes(q)) ||
                    f.price.toString().includes(q)
            );
        }

        // Multi-field sorting
        list.sort((a, b) => {
            let valA: any = a[sortField];
            let valB: any = b[sortField];

            if (sortField === 'transactTime') {
                valA = new Date(a.transactTime).getTime();
                valB = new Date(b.transactTime).getTime();
            }

            if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });

        return list;
    }, [activeFillsList, selectedSymbol, searchQuery, sortField, sortDirection]);

    // Handle Header Click Sort
    const handleHeaderClick = (_colKey: string, sortKey?: SortField) => {
        if (!sortKey) return;
        if (sortField === sortKey) {
            setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortField(sortKey);
            setSortDirection('desc');
        }
    };

    // Row Selection Handlers
    const handleToggleSelectAll = () => {
        if (selectedRowIds.size === processedFills.length && processedFills.length > 0) {
            setSelectedRowIds(new Set());
        } else {
            setSelectedRowIds(new Set(processedFills.map((f) => f.id)));
        }
    };

    const handleToggleSelectRow = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedRowIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Column Configuration Context Menu Handlers
    const handleContextMenu = (e: React.MouseEvent, colKey: string) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, colKey });
    };

    const toggleColumnVisibility = (key: string) => {
        setColumns((prev) =>
            prev.map((col) => (col.key === key ? { ...col, visible: !col.visible } : col))
        );
    };

    const resetSorting = () => {
        setSortField('transactTime');
        setSortDirection('desc');
        setContextMenu(null);
    };

    // Quick Export / Copy
    const handleCopySelection = () => {
        const target = selectedRowIds.size > 0
            ? processedFills.filter((f) => selectedRowIds.has(f.id))
            : processedFills;
        navigator.clipboard.writeText(JSON.stringify(target, null, 2));
    };

    const handleExportCSV = () => {
        const rows = [
            ['ID', 'Transact Time', 'Exchange', 'Contract', 'Side', 'Filled', 'Price', 'ExeQty', 'Order ID'],
            ...processedFills.map((f) => [
                f.id,
                f.transactTime,
                f.exchange,
                f.contract,
                f.side,
                f.filledQty,
                f.price,
                f.exeQty,
                f.orderId || '',
            ]),
        ];
        const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `fill_alert_export_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const totalFilledLots = processedFills.reduce((sum, f) => sum + f.filledQty, 0);

    return (
        <div
            className="w-full h-full min-h-0 flex flex-col gap-2 text-xs font-mono select-none overflow-hidden"
            onClick={() => setContextMenu(null)}
        >
            {/* 1. Sub-Header Control Bar */}
            <div className="bg-[#e2e6eb] p-2 rounded border border-[#b4bcc8] flex flex-wrap items-center justify-between gap-2 shrink-0 shadow-sm">
                {/* Left: Mode Selector Dropdown & Live Status */}
                <div className="flex items-center gap-2.5">
                    {/* Mode Selector */}
                    <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded border border-[#b4bcc8] shadow-sm">
                        <span className="text-[10px] text-slate-600 uppercase font-bold">View:</span>
                        <div className="relative">
                            <select
                                value={mode}
                                onChange={(e) => handleToggleMode(e.target.value as ModeType)}
                                className="bg-transparent text-[11px] font-black text-slate-900 outline-none cursor-pointer pr-4 appearance-none"
                            >
                                <option value="CONTINUOUS">
                                    Continuous ▾
                                </option>
                                <option value="SNAPSHOT">
                                    Snapshot
                                </option>
                            </select>
                            <ChevronDown size={11} className="absolute right-0 top-1 text-slate-600 pointer-events-none" />
                        </div>
                    </div>

                    {/* Mode Status Pill */}
                    {mode === 'CONTINUOUS' ? (
                        <div className="flex items-center gap-1 px-2 py-0.5 bg-emerald-100 text-emerald-900 border border-emerald-300 rounded text-[10px] font-bold shadow-sm">
                            <Radio size={10} className="animate-pulse text-emerald-700" />
                            <span>LIVE APPEND</span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-900 border border-amber-300 rounded text-[10px] font-bold shadow-sm">
                            <Pause size={10} className="text-amber-700" />
                            <span>FROZEN</span>
                        </div>
                    )}

                    {/* Fills Counter Summary */}
                    <div className="hidden sm:flex items-center gap-2 text-[10px] pl-2 border-l border-[#b4bcc8] text-slate-600">
                        <span>
                            Fills: <strong className="text-slate-900 font-bold">{processedFills.length}</strong>
                        </span>
                        <span>
                            Lots: <strong className="text-slate-900 font-bold">{totalFilledLots}</strong>
                        </span>
                    </div>
                </div>

                {/* Right: Filter by Contract, Search & Clear Button */}
                <div className="flex items-center gap-2">
                    {/* Contract Selector */}
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

                    {/* Search Input */}
                    <div className="flex items-center gap-1 bg-white border border-[#b4bcc8] rounded px-2 py-0.5 shadow-sm">
                        <Search size={11} className="text-slate-500" />
                        <input
                            type="text"
                            placeholder="Filter fills..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="bg-transparent text-[10px] text-slate-800 placeholder-slate-400 outline-none w-16 sm:w-24"
                        />
                    </div>

                    {/* Prominent Top Clear Button */}
                    <button
                        onClick={onClear}
                        className="flex items-center gap-1 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-[11px] rounded border border-amber-700 shadow-sm transition active:scale-95 cursor-pointer shrink-0"
                        title="Clear all alerts from active view (does not modify DB/Fill Book)"
                    >
                        <Trash2 size={11} />
                        <span>Clear</span>
                    </button>
                </div>
            </div>

            {/* 2. Snapshot Pending Notification Banner */}
            {mode === 'SNAPSHOT' && pendingCount > 0 && (
                <div className="bg-amber-100 border border-amber-300 text-amber-900 px-3 py-1 rounded flex items-center justify-between text-[11px] shrink-0 animate-pulse shadow-sm">
                    <div className="flex items-center gap-1.5 font-bold">
                        <BellRing size={12} className="text-amber-700" />
                        <span>{pendingCount} new fill{pendingCount > 1 ? 's' : ''} received in background</span>
                    </div>
                    <button
                        onClick={handleApplySnapshotPending}
                        className="px-2 py-0.5 bg-amber-600 hover:bg-amber-700 text-white font-extrabold rounded text-[10px] transition shadow-sm"
                    >
                        Update Snapshot
                    </button>
                </div>
            )}

            {/* 3. Table Blotter */}
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto border border-[#b4bcc8] rounded bg-white shadow-inner relative">
                <table className="w-full text-left text-xs border-collapse">
                    <thead className="sticky top-0 bg-[#eef1f6] border-b border-[#b4bcc8] z-10 select-none shadow-sm">
                        <tr className="text-[9px] text-slate-700 uppercase font-extrabold">
                            {/* Checkbox Column */}
                            {columns.find((c) => c.key === 'select')?.visible && (
                                <th className="py-1.5 px-2 w-7 text-center">
                                    <button
                                        onClick={handleToggleSelectAll}
                                        className="text-slate-600 hover:text-slate-900 transition"
                                        title="Select / Deselect All"
                                    >
                                        {selectedRowIds.size > 0 && selectedRowIds.size === processedFills.length ? (
                                            <CheckSquare size={13} className="text-blue-700" />
                                        ) : (
                                            <Square size={13} />
                                        )}
                                    </button>
                                </th>
                            )}

                            {/* Transact Time */}
                            {columns.find((c) => c.key === 'transactTime')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('transactTime', 'transactTime')}
                                    onContextMenu={(e) => handleContextMenu(e, 'transactTime')}
                                    className="py-1.5 px-2 cursor-pointer hover:text-slate-900 transition whitespace-nowrap"
                                    title="Right-click for options / Left-click to sort"
                                >
                                    <div className="flex items-center gap-1">
                                        <span>
                                            {sortField === 'transactTime' ? (sortDirection === 'desc' ? '▼1 ' : '▲1 ') : ''}
                                            Transact Time
                                        </span>
                                        {sortField !== 'transactTime' && <ArrowUpDown size={10} className="opacity-40" />}
                                    </div>
                                </th>
                            )}

                            {/* Exchange */}
                            {columns.find((c) => c.key === 'exchange')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('exchange', 'exchange')}
                                    onContextMenu={(e) => handleContextMenu(e, 'exchange')}
                                    className="py-1.5 px-2 text-center cursor-pointer hover:text-slate-900 transition whitespace-nowrap"
                                    title="Right-click for options / Left-click to sort"
                                >
                                    <div className="flex items-center justify-center gap-1">
                                        <span>
                                            {sortField === 'exchange' ? (sortDirection === 'desc' ? '▼2 ' : '▲2 ') : ''}
                                            Exch
                                        </span>
                                        {sortField !== 'exchange' && <ArrowUpDown size={10} className="opacity-40" />}
                                    </div>
                                </th>
                            )}

                            {/* Contract */}
                            {columns.find((c) => c.key === 'contract')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('contract', 'contract')}
                                    onContextMenu={(e) => handleContextMenu(e, 'contract')}
                                    className="py-1.5 px-2 cursor-pointer hover:text-slate-900 transition whitespace-nowrap"
                                >
                                    <div className="flex items-center gap-1">
                                        <span>Contract</span>
                                        {sortField === 'contract' && (
                                            <span>{sortDirection === 'desc' ? '▼' : '▲'}</span>
                                        )}
                                    </div>
                                </th>
                            )}

                            {/* Side */}
                            {columns.find((c) => c.key === 'side')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('side', 'side')}
                                    onContextMenu={(e) => handleContextMenu(e, 'side')}
                                    className="py-1.5 px-2 text-center cursor-pointer hover:text-slate-900 transition"
                                >
                                    <span>Side</span>
                                </th>
                            )}

                            {/* Filled */}
                            {columns.find((c) => c.key === 'filledQty')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('filledQty', 'filledQty')}
                                    onContextMenu={(e) => handleContextMenu(e, 'filledQty')}
                                    className="py-1.5 px-2 text-right cursor-pointer hover:text-slate-900 transition"
                                >
                                    <span>Filled</span>
                                </th>
                            )}

                            {/* Price */}
                            {columns.find((c) => c.key === 'price')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('price', 'price')}
                                    onContextMenu={(e) => handleContextMenu(e, 'price')}
                                    className="py-1.5 px-2 text-right cursor-pointer hover:text-slate-900 transition"
                                >
                                    <span>Price</span>
                                </th>
                            )}

                            {/* ExeQty */}
                            {columns.find((c) => c.key === 'exeQty')?.visible && (
                                <th
                                    onClick={() => handleHeaderClick('exeQty', 'exeQty')}
                                    onContextMenu={(e) => handleContextMenu(e, 'exeQty')}
                                    className="py-1.5 px-2 text-right cursor-pointer hover:text-slate-900 transition"
                                >
                                    <span>ExeQty</span>
                                </th>
                            )}

                            {/* Order ID (Optional Column) */}
                            {columns.find((c) => c.key === 'orderId')?.visible && (
                                <th
                                    onContextMenu={(e) => handleContextMenu(e, 'orderId')}
                                    className="py-1.5 px-2 cursor-pointer hover:text-slate-900 transition"
                                >
                                    <span>Order ID</span>
                                </th>
                            )}
                        </tr>
                    </thead>

                    <tbody className="divide-y divide-[#cbd5e1]">
                        {processedFills.length === 0 ? (
                            <tr>
                                <td colSpan={9} className="text-center py-12 text-slate-500 text-xs">
                                    <div className="flex flex-col items-center justify-center gap-1.5">
                                        <BellRing size={20} className="text-slate-400" />
                                        <span className="font-bold">No fill alerts recorded yet.</span>
                                        <span className="text-[10px] text-slate-500">
                                            Fills from executed trades will automatically appear here.
                                        </span>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            processedFills.map((fill, index) => {
                                const isSelected = selectedRowIds.has(fill.id);
                                const isBuy = fill.side === 'BUY';
                                const decimals = INSTRUMENTS[fill.contract]?.decimals || 2;
                                const venueClass = VENUE_BADGE_STYLES[fill.exchange] || 'bg-slate-100 text-slate-800 border-slate-300';

                                // Alternating background shading
                                const rowBg = isSelected
                                    ? 'bg-blue-50/90 border-l-2 border-l-blue-600'
                                    : index % 2 === 0
                                        ? 'bg-white hover:bg-slate-50'
                                        : 'bg-slate-50/50 hover:bg-slate-100/70';

                                return (
                                    <tr
                                        key={fill.id || index}
                                        onClick={(e) => handleToggleSelectRow(fill.id, e)}
                                        className={`transition cursor-pointer ${rowBg}`}
                                    >
                                        {/* Selection Checkbox */}
                                        {columns.find((c) => c.key === 'select')?.visible && (
                                            <td className="py-1.5 px-2 text-center" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={(e) => handleToggleSelectRow(fill.id, e as any)}
                                                    className="accent-blue-600 cursor-pointer"
                                                />
                                            </td>
                                        )}

                                        {/* Transact Time (Millisecond precision) */}
                                        {columns.find((c) => c.key === 'transactTime')?.visible && (
                                            <td
                                                className="py-1.5 px-2 text-[10px] text-slate-600 font-mono whitespace-nowrap"
                                                title={fill.transactTime}
                                            >
                                                {formatMsTime(fill.transactTime)}
                                            </td>
                                        )}

                                        {/* Exchange Badge */}
                                        {columns.find((c) => c.key === 'exchange')?.visible && (
                                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                                <span
                                                    className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold border uppercase tracking-wider ${venueClass}`}
                                                >
                                                    {fill.exchange}
                                                </span>
                                            </td>
                                        )}

                                        {/* Contract Symbol */}
                                        {columns.find((c) => c.key === 'contract')?.visible && (
                                            <td className="py-1.5 px-2 font-bold text-slate-900 whitespace-nowrap">
                                                {fill.contract}
                                            </td>
                                        )}

                                        {/* Side (Buy blue / Sell red) */}
                                        {columns.find((c) => c.key === 'side')?.visible && (
                                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                                <span
                                                    className={`font-black px-1.5 py-0.5 rounded text-[10px] ${isBuy
                                                        ? 'bg-blue-100 text-blue-800 border border-blue-300'
                                                        : 'bg-red-100 text-red-800 border border-red-300'
                                                        }`}
                                                >
                                                    {isBuy ? 'Buy' : 'Sell'}
                                                </span>
                                            </td>
                                        )}

                                        {/* Filled Qty */}
                                        {columns.find((c) => c.key === 'filledQty')?.visible && (
                                            <td className="py-1.5 px-2 text-right font-bold text-slate-900">
                                                {fill.filledQty}
                                            </td>
                                        )}

                                        {/* Execution Price */}
                                        {columns.find((c) => c.key === 'price')?.visible && (
                                            <td className="py-1.5 px-2 text-right font-black text-blue-900">
                                                {fill.price.toFixed(decimals)}
                                            </td>
                                        )}

                                        {/* ExeQty */}
                                        {columns.find((c) => c.key === 'exeQty')?.visible && (
                                            <td className="py-1.5 px-2 text-right text-slate-800 font-semibold">
                                                {fill.exeQty}
                                            </td>
                                        )}

                                        {/* Order ID */}
                                        {columns.find((c) => c.key === 'orderId')?.visible && (
                                            <td
                                                className="py-1.5 px-2 font-mono text-[10px] text-slate-500 truncate max-w-[90px]"
                                                title={fill.orderId || fill.id}
                                            >
                                                {fill.orderId || fill.id}
                                            </td>
                                        )}
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* 4. Right-Click Column Header Context Menu */}
            {contextMenu && (
                <div
                    className="fixed z-50 bg-white border border-[#b4bcc8] rounded-lg shadow-2xl p-2 text-xs flex flex-col gap-1 w-48 text-slate-900"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="text-[10px] font-bold text-slate-500 uppercase px-2 py-0.5 border-b border-[#b4bcc8]">
                        Column Options
                    </div>
                    <button
                        onClick={() => {
                            const col = columns.find((c) => c.key === contextMenu.colKey);
                            if (col?.sortKey) {
                                setSortField(col.sortKey);
                                setSortDirection('asc');
                            }
                            setContextMenu(null);
                        }}
                        className="text-left px-2 py-1 rounded hover:bg-slate-100 text-slate-800 transition"
                    >
                        ▲ Sort Ascending
                    </button>
                    <button
                        onClick={() => {
                            const col = columns.find((c) => c.key === contextMenu.colKey);
                            if (col?.sortKey) {
                                setSortField(col.sortKey);
                                setSortDirection('desc');
                            }
                            setContextMenu(null);
                        }}
                        className="text-left px-2 py-1 rounded hover:bg-slate-100 text-slate-800 transition"
                    >
                        ▼ Sort Descending
                    </button>
                    <button
                        onClick={resetSorting}
                        className="text-left px-2 py-1 rounded hover:bg-slate-100 text-slate-800 transition border-b border-[#b4bcc8] pb-1 mb-1"
                    >
                        ↺ Reset Sorting
                    </button>

                    <div className="text-[10px] font-bold text-slate-500 uppercase px-2 py-0.5">
                        Visible Columns
                    </div>
                    {columns
                        .filter((c) => c.key !== 'select')
                        .map((col) => (
                            <label
                                key={col.key}
                                className="flex items-center gap-2 px-2 py-0.5 rounded hover:bg-slate-100 cursor-pointer text-[11px]"
                            >
                                <input
                                    type="checkbox"
                                    checked={col.visible}
                                    onChange={() => toggleColumnVisibility(col.key)}
                                    className="accent-blue-600"
                                />
                                <span>{col.label}</span>
                            </label>
                        ))}
                </div>
            )}

            {/* 5. Footer Action Controls */}
            <div className="flex items-center justify-between gap-2 shrink-0 pt-1 border-t border-[#b4bcc8]">
                {/* Left: Selection info & Quick Actions */}
                <div className="flex items-center gap-2">
                    {selectedRowIds.size > 0 ? (
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-blue-800">
                                {selectedRowIds.size} row{selectedRowIds.size > 1 ? 's' : ''} selected
                            </span>
                            <button
                                onClick={handleCopySelection}
                                className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-800 text-[10px] rounded border border-[#b4bcc8] transition shadow-sm active:scale-95"
                                title="Copy selected rows as JSON"
                            >
                                <Copy size={11} />
                                <span>Copy</span>
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-1.5 text-slate-500 text-[10px]">
                            <Eye size={11} />
                            <span>Right-click headers for column filters</span>
                        </div>
                    )}

                    <button
                        onClick={handleExportCSV}
                        className="flex items-center gap-1 px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-700 hover:text-slate-900 text-[10px] font-bold rounded border border-[#b4bcc8] transition shadow-sm active:scale-95"
                        title="Export active alerts to CSV"
                    >
                        <Download size={11} />
                        <span className="hidden sm:inline">CSV</span>
                    </button>
                </div>

                {/* Right: Dedicated Clear Orange Button */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={onClear}
                        className="flex items-center gap-1.5 px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-xs rounded border border-amber-700 shadow-sm transition active:scale-95 cursor-pointer"
                        title="Clear all alerts from active view (does not modify DB/Fill Book)"
                    >
                        <Trash2 size={12} />
                        <span>Clear</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
