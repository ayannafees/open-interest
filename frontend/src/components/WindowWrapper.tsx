import React from 'react';
import { Rnd } from 'react-rnd';
import { Minus, Square, Minimize2, X, Move } from 'lucide-react';
import { INSTRUMENTS, INSTRUMENT_SYMBOLS } from '../constants/instruments';
import type { WindowInstance } from '../types/window';

interface WindowWrapperProps {
    window: WindowInstance;
    onFocus: (id: string) => void;
    onClose: (id: string) => void;
    onMinimize: (id: string) => void;
    onToggleMaximize: (id: string) => void;
    onInstrumentChange: (id: string, newSymbol: string) => void;
    onUpdatePosition: (id: string, x: number, y: number) => void;
    onUpdateSize: (id: string, width: number, height: number, x: number, y: number) => void;
    onDragLive?: (right: number, bottom: number) => void;
    onDragEnd?: () => void;
    children: React.ReactNode;
}

export const WindowWrapper: React.FC<WindowWrapperProps> = ({
    window: win,
    onFocus,
    onClose,
    onMinimize,
    onToggleMaximize,
    onInstrumentChange,
    onUpdatePosition,
    onUpdateSize,
    onDragLive,
    onDragEnd,
    children,
}) => {
    if (win.isMinimized) {
        return null;
    }

    const supportsProductSelector =
        win.type !== 'POSITION_BOOK' &&
        win.type !== 'FILL_BOOK' &&
        win.type !== 'FILL_ALERT' &&
        win.type !== 'LIMITS';

    if (win.isMaximized) {
        return (
            <div
                className="fixed inset-x-0 top-[52px] bottom-0 flex flex-col bg-terminal-card border-2 border-terminal-accent shadow-xl overflow-hidden"
                style={{ zIndex: win.zIndex }}
                onPointerDownCapture={() => onFocus(win.id)}
                onMouseDownCapture={() => onFocus(win.id)}
            >
                {/* Window Header */}
                <div
                    className="bg-[#d4d8df] border-b border-[#b4bcc8] px-3 py-1.5 flex items-center justify-between select-none shrink-0"
                    onPointerDownCapture={() => onFocus(win.id)}
                    onMouseDownCapture={() => onFocus(win.id)}
                >
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-black text-terminal-text tracking-wider uppercase">
                            {win.title}
                        </span>

                        {/* Soft Amber SIMULATION Badge for Fill Alert */}
                        {win.type === 'FILL_ALERT' && (
                            <span className="bg-amber-100 text-amber-800 text-[9px] font-extrabold px-1.5 py-0.5 rounded border border-amber-300 uppercase tracking-wider">
                                SIMULATION
                            </span>
                        )}

                        {/* Per-Widget Product Dropdown */}
                        {supportsProductSelector && (
                            <div
                                className="flex items-center bg-white border border-[#9ca3af] rounded px-2 py-0.5 ml-2 shadow-sm"
                                onMouseDown={(e) => {
                                    e.stopPropagation();
                                    onFocus(win.id);
                                }}
                            >
                                <span className="text-[10px] text-slate-700 mr-1.5 uppercase font-black">
                                    Product:
                                </span>
                                <select
                                    value={win.instrument}
                                    onChange={(e) => onInstrumentChange(win.id, e.target.value)}
                                    className="bg-white text-xs font-black text-slate-900 outline-none cursor-pointer"
                                    style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
                                >
                                    {INSTRUMENT_SYMBOLS.map((sym) => (
                                        <option key={sym} value={sym} className="bg-white text-slate-900 font-bold" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>
                                            {sym} — {INSTRUMENTS[sym]?.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* Window Controls */}
                    <div
                        className="flex items-center gap-1.5"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onFocus(win.id);
                        }}
                    >
                        <button
                            onClick={() => onMinimize(win.id)}
                            className="p-1 text-terminal-muted hover:text-terminal-text hover:bg-black/5 rounded transition"
                            title="Minimize to Dock"
                        >
                            <Minus size={13} />
                        </button>
                        <button
                            onClick={() => onToggleMaximize(win.id)}
                            className="p-1 text-terminal-muted hover:text-terminal-text hover:bg-black/5 rounded transition"
                            title="Restore Window"
                        >
                            <Minimize2 size={13} />
                        </button>
                        <button
                            onClick={() => onClose(win.id)}
                            className="p-1 text-terminal-muted hover:text-terminal-sell hover:bg-red-100 rounded transition ml-1"
                            title="Close Widget"
                        >
                            <X size={13} />
                        </button>
                    </div>
                </div>

                {/* Maximized Window Body */}
                <div
                    className="flex-1 min-h-0 h-full overflow-hidden relative p-1.5 bg-[#edf0f5] flex flex-col"
                    onPointerDownCapture={() => onFocus(win.id)}
                    onMouseDownCapture={() => onFocus(win.id)}
                >
                    {children}
                </div>
            </div>
        );
    }

    return (
        <Rnd
            size={{ width: win.width, height: win.height }}
            position={{ x: win.x, y: win.y }}
            onDragStart={() => onFocus(win.id)}
            onDrag={(_e, d) => {
                const right = Math.max(0, d.x) + win.width;
                const bottom = Math.max(0, d.y) + win.height;
                onDragLive?.(right, bottom);
            }}
            onDragStop={(_e, d) => {
                const safeX = Math.max(0, d.x);
                const safeY = Math.max(0, d.y);
                onUpdatePosition(win.id, safeX, safeY);
                onDragEnd?.();
            }}
            onResizeStart={() => onFocus(win.id)}
            onResize={(_e, _direction, ref, _delta, position) => {
                const right = Math.max(0, position.x) + parseInt(ref.style.width, 10);
                const bottom = Math.max(0, position.y) + parseInt(ref.style.height, 10);
                onDragLive?.(right, bottom);
            }}
            onResizeStop={(_e, _direction, ref, _delta, position) => {
                const safeX = Math.max(0, position.x);
                const safeY = Math.max(0, position.y);
                onUpdateSize(
                    win.id,
                    parseInt(ref.style.width, 10),
                    parseInt(ref.style.height, 10),
                    safeX,
                    safeY
                );
                onDragEnd?.();
            }}
            dragHandleClassName="window-drag-handle"
            minWidth={320}
            minHeight={220}
            style={{ zIndex: win.zIndex }}
            className="flex flex-col bg-[#edf0f5] border border-[#9ca3af] hover:border-[#6b7280] rounded shadow-lg overflow-hidden focus-within:border-terminal-accent transition-colors duration-150"
            onPointerDownCapture={() => onFocus(win.id)}
            onMouseDownCapture={() => onFocus(win.id)}
        >
            {/* Window Header */}
            <div
                className="window-drag-handle bg-[#d4d8df] border-b border-[#b4bcc8] px-2.5 py-1 flex items-center justify-between cursor-move select-none shrink-0"
                onPointerDownCapture={() => onFocus(win.id)}
                onMouseDownCapture={() => onFocus(win.id)}
            >
                <div className="flex items-center gap-1.5 overflow-hidden">
                    <Move size={11} className="text-terminal-muted shrink-0" />
                    <span className="text-xs font-black text-terminal-text tracking-wider uppercase truncate">
                        {win.title}
                    </span>

                    {/* Soft Amber SIMULATION Badge for Fill Alert */}
                    {win.type === 'FILL_ALERT' && (
                        <span className="bg-amber-100 text-amber-800 text-[9px] font-extrabold px-1.5 py-0.2 rounded border border-amber-300 uppercase tracking-wider shrink-0">

                        </span>
                    )}

                    {/* Per-Widget Product Dropdown */}
                    {supportsProductSelector && (
                        <div
                            className="flex items-center bg-white border border-[#9ca3af] rounded px-1.5 py-0.2 ml-1 shrink-0 shadow-sm"
                            onMouseDown={(e) => {
                                e.stopPropagation();
                                onFocus(win.id);
                            }}
                        >
                            <span className="text-[10px] text-slate-700 mr-1 uppercase font-black">
                                Sym:
                            </span>
                            <select
                                value={win.instrument}
                                onChange={(e) => onInstrumentChange(win.id, e.target.value)}
                                className="bg-white text-xs font-black text-slate-900 outline-none cursor-pointer"
                                style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
                            >
                                {INSTRUMENT_SYMBOLS.map((sym) => (
                                    <option key={sym} value={sym} className="bg-white text-slate-900 font-bold" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>
                                        {sym}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>

                {/* Window Controls */}
                <div
                    className="flex items-center gap-0.5 shrink-0 ml-2"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        onFocus(win.id);
                    }}
                >
                    <button
                        onClick={() => onMinimize(win.id)}
                        className="p-1 text-terminal-muted hover:text-terminal-text hover:bg-black/5 rounded transition"
                        title="Minimize to Dock"
                    >
                        <Minus size={11} />
                    </button>
                    <button
                        onClick={() => onToggleMaximize(win.id)}
                        className="p-1 text-terminal-muted hover:text-terminal-text hover:bg-black/5 rounded transition"
                        title="Maximize Window"
                    >
                        <Square size={11} />
                    </button>
                    <button
                        onClick={() => onClose(win.id)}
                        className="p-1 text-terminal-muted hover:text-terminal-sell hover:bg-red-100 rounded transition"
                        title="Close Window"
                    >
                        <X size={11} />
                    </button>
                </div>
            </div>

            {/* Floating Window Body */}
            <div
                className="flex-1 min-h-0 h-full overflow-hidden relative p-1.5 bg-[#edf0f5] flex flex-col"
                onPointerDownCapture={() => onFocus(win.id)}
                onMouseDownCapture={() => onFocus(win.id)}
            >
                {children}
            </div>
        </Rnd>
    );
};