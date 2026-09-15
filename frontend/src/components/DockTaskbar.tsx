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
} from 'lucide-react';
import type { WindowInstance, WidgetType } from '../types/window';

interface DockTaskbarProps {
    minimizedWindows: WindowInstance[];
    onRestore: (id: string) => void;
}

const WIDGET_ICONS: Record<WidgetType, React.ReactNode> = {
    CHART: <TrendingUp size={12} className="text-blue-400" />,
    LADDER: <Layers size={12} className="text-emerald-400" />,
    ORDER_TICKET: <FileSpreadsheet size={12} className="text-yellow-400" />,
    ORDER_BOOK: <ClipboardList size={12} className="text-amber-400" />,
    TAS: <ListOrdered size={12} className="text-cyan-400" />,
    POSITION_BOOK: <Briefcase size={12} className="text-purple-400" />,
    FILL_BOOK: <Receipt size={12} className="text-pink-400" />,
    LIMITS: <ShieldCheck size={12} className="text-amber-400" />,
    FILL_ALERT: <BellRing size={12} className="text-amber-400" />,
};

export const DockTaskbar: React.FC<DockTaskbarProps> = ({ minimizedWindows, onRestore }) => {
    if (minimizedWindows.length === 0) {
        return null;
    }

    return (
        <div
            className="fixed bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-[#d4d8df]/95 backdrop-blur border border-[#b4bcc8] px-3 py-1.5 rounded-full shadow-2xl"
            style={{ zIndex: 99999 }}
        >
            <span className="text-[10px] text-slate-700 font-bold uppercase tracking-wider pr-1 border-r border-[#b4bcc8]">
                Dock ({minimizedWindows.length})
            </span>
            {minimizedWindows.map((win) => (
                <button
                    key={win.id}
                    onClick={() => onRestore(win.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-900 text-xs font-bold rounded-full border border-[#b4bcc8] transition active:scale-95 shadow-sm"
                >
                    {WIDGET_ICONS[win.type]}
                    <span className="truncate max-w-[120px]">
                        {win.title} ({win.instrument})
                    </span>
                </button>
            ))}
        </div>
    );
};