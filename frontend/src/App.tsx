import { useState, useEffect, useMemo, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { playOrderPlacedSound, playFillChime } from './utils/audio';
import { INSTRUMENT_SYMBOLS, DEFAULT_INSTRUMENT, INSTRUMENTS } from './constants/instruments';
import type { WindowInstance, WidgetType } from './types/window';
import type { FillAlertItem } from './types/order';
import { WorkspaceToolbar } from './components/WorkspaceToolbar';
import type { TraderAccount } from './components/WorkspaceToolbar';
import { WindowWrapper } from './components/WindowWrapper';
import { DockTaskbar } from './components/DockTaskbar';
import { AuthModal } from './components/AuthModal';
import { BellRing, ShieldCheck, X } from 'lucide-react';

import { ChartWidget } from './components/ChartWidget';
import { LadderWidget } from './components/LadderWidget';
import { OrderTicketWidget } from './components/OrderTicketWidget';
import { OrderBookWidget } from './components/OrderBookWidget';
import { TimeAndSalesWidget } from './components/TimeAndSalesWidget';
import { PositionBookWidget } from './components/PositionBookWidget';
import { FillBookWidget } from './components/FillBookWidget';
import { FillAlertWidget } from './components/FillAlertWidget';
import { RiskLimitsWidget } from './components/RiskLimitsWidget';

const STORAGE_KEY = 'oi_workspace_windows';

export default function App() {
  // 1. Auth & RBAC State
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('oi_token'));
  const [traderId, setTraderId] = useState<string | null>(() => localStorage.getItem('oi_traderId'));
  const [username, setUsername] = useState<string>(() => localStorage.getItem('oi_username') || '');
  const [role, setRole] = useState<'ADMIN' | 'TRADER' | string>(() => localStorage.getItem('oi_role') || 'TRADER');

  // Admin active trader switcher & features state
  const [activeTraderId, setActiveTraderId] = useState<string | null>(() => localStorage.getItem('oi_traderId'));
  const [availableTraders, setAvailableTraders] = useState<TraderAccount[]>([]);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);

  // Admin MDS Market Mode State ('RANDOM_WALK' vs 'USER_DRIVEN')
  const [marketMode, setMarketMode] = useState<'RANDOM_WALK' | 'USER_DRIVEN'>('RANDOM_WALK');

  // Admin Pending Limit Requests Alert & Badge
  const [pendingLimitRequestsCount, setPendingLimitRequestsCount] = useState<number>(0);
  const [limitRequestAlert, setLimitRequestAlert] = useState<any | null>(null);
  const [liveLimitsUpdate, setLiveLimitsUpdate] = useState<{ traderId: string; limits: any[]; timestamp: string } | null>(null);

  const effectiveTraderId = role === 'ADMIN' ? (activeTraderId || traderId) : traderId;

  // 2. Fetch Admin Traders List when logged in as ADMIN
  const fetchAdminTraders = useCallback(async (authToken: string) => {
    try {
      const res = await fetch('/api/admin/traders', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const traders: TraderAccount[] = await res.json();
        setAvailableTraders(traders);
      }
    } catch { }
  }, []);

  // Fetch Exchange Market Mode (Admin Only)
  const fetchMarketMode = useCallback(async (authToken: string) => {
    try {
      const res = await fetch('/api/admin/market-mode', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.mode) setMarketMode(data.mode);
      }
    } catch { }
  }, []);

  // Fetch Pending Limit Requests Count (Admin Only)
  const fetchPendingRequestsCount = useCallback(async (authToken: string) => {
    try {
      const res = await fetch('/api/admin/limit-requests', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const requests: any[] = await res.json();
        const pending = requests.filter((r) => r.status === 'PENDING').length;
        setPendingLimitRequestsCount(pending);
      }
    } catch { }
  }, []);

  // Validate session & load admin accounts on start
  useEffect(() => {
    if (!token) return;

    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('Session invalid');
      })
      .then((userData) => {
        const userRole = userData.role || 'TRADER';
        setRole(userRole);
        localStorage.setItem('oi_role', userRole);

        if (userRole === 'ADMIN') {
          fetchAdminTraders(token);
          fetchMarketMode(token);
          fetchPendingRequestsCount(token);
        }
      })
      .catch(() => {
        handleLogout();
      });
  }, [token, fetchAdminTraders, fetchMarketMode, fetchPendingRequestsCount]);

  // 3. Windows State (Persisted in localStorage)
  const [windows, setWindows] = useState<WindowInstance[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: WindowInstance[] = JSON.parse(saved);
        return parsed.map((w) => {
          if (w.type === 'ORDER_BOOK' && (w.title === 'Working Orders Blotter' || !w.title)) {
            return { ...w, title: 'Order Book' };
          }
          if (w.type === 'TAS' && (w.title === 'Time & Sales Tape' || !w.title)) {
            return { ...w, title: 'Time & Sales' };
          }
          return w;
        });
      }
    } catch { }
    return [];
  });

  useEffect(() => {
    try {
      if (token) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(windows));
      }
    } catch { }
  }, [windows, token]);

  const activeSymbols = useMemo(() => {
    const syms = new Set<string>(INSTRUMENT_SYMBOLS);
    windows.forEach((w) => {
      if (w.instrument) syms.add(w.instrument);
    });
    return Array.from(syms);
  }, [windows]);

  // Dynamic Canvas Dimensions so the screen is limited to the visible viewport,
  // expanding dynamically only when widgets are dragged or resized beyond the edge,
  // and auto-shrinking when widgets are moved back up or deleted.
  const [activeDragBounds, setActiveDragBounds] = useState<{ right: number; bottom: number } | null>(null);

  const canvasDimensions = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    windows.forEach((w) => {
      if (!w.isMinimized && !w.isMaximized) {
        const right = w.x + w.width;
        const bottom = w.y + w.height;
        if (right > maxX) maxX = right;
        if (bottom > maxY) maxY = bottom;
      }
    });

    if (activeDragBounds) {
      if (activeDragBounds.right > maxX) maxX = activeDragBounds.right;
      if (activeDragBounds.bottom > maxY) maxY = activeDragBounds.bottom;
    }

    const padding = 30; // 30px margin when scrolled to the edge
    return {
      width: maxX > 0 ? maxX + padding : 0,
      height: maxY > 0 ? maxY + padding : 0,
    };
  }, [windows, activeDragBounds]);

  const handleDragLive = useCallback((right: number, bottom: number) => {
    setActiveDragBounds((prev) => {
      if (prev && prev.right === right && prev.bottom === bottom) return prev;
      return { right, bottom };
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    setActiveDragBounds(null);
  }, []);

  // 4. Fill Alert Singleton Auto-Popup Trigger Handler
  const handleAutoSpawnFillAlert = useCallback((_fill?: FillAlertItem) => {
    setWindows((curr) => {
      const maxZ = curr.reduce((max, w) => Math.max(max, w.zIndex || 0), 10);
      const nextZ = maxZ + 1;
      const existing = curr.find((w) => w.type === 'FILL_ALERT');
      if (existing) {
        return curr.map((w) =>
          w.id === existing.id
            ? { ...w, isMinimized: false, zIndex: nextZ }
            : w
        );
      } else {
        const newWin: WindowInstance = {
          id: 'win_FILL_ALERT_singleton',
          type: 'FILL_ALERT',
          title: 'Fill Alert',
          instrument: 'ALL',
          x: Math.max(30, Math.min(window.innerWidth - 660, 160)),
          y: Math.max(30, Math.min(window.innerHeight - 360, 100)),
          width: 620,
          height: 320,
          zIndex: nextZ,
          isMinimized: false,
          isMaximized: false,
        };
        return [...curr, newWin];
      }
    });
  }, []);

  // Handler: Real-time Limit Increase Alert pushed to connected Admins
  const handleLimitAlertReceived = useCallback((alertData: any) => {
    playFillChime();
    setLimitRequestAlert(alertData);
    setPendingLimitRequestsCount((prev) => prev + 1);
  }, []);

  const handleLimitsUpdated = useCallback((data: any) => {
    setLiveLimitsUpdate(data);
  }, []);

  const handleMarketModeChanged = useCallback((newMode: string) => {
    if (newMode === 'RANDOM_WALK' || newMode === 'USER_DRIVEN') {
      setMarketMode(newMode);
    }
  }, []);

  // 5. Connect to WebSocket Engine
  const ws = useWebSocket({
    token,
    traderId: effectiveTraderId,
    activeSymbols,
    onFillReceived: handleAutoSpawnFillAlert,
    onLimitAlertReceived: handleLimitAlertReceived,
    onLimitsUpdated: handleLimitsUpdated,
    onMarketModeChanged: handleMarketModeChanged,
  });

  // 6. Auth Handlers
  const handleAuthSuccess = (newToken: string, user: { id: string; username: string; role: string }) => {
    localStorage.setItem('oi_token', newToken);
    localStorage.setItem('oi_traderId', user.id);
    localStorage.setItem('oi_username', user.username);
    localStorage.setItem('oi_role', user.role || 'TRADER');

    setToken(newToken);
    setTraderId(user.id);
    setUsername(user.username);
    setRole(user.role || 'TRADER');
    setActiveTraderId(user.id);

    if (user.role === 'ADMIN') {
      fetchAdminTraders(newToken);
      fetchMarketMode(newToken);
      fetchPendingRequestsCount(newToken);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('oi_token');
    localStorage.removeItem('oi_traderId');
    localStorage.removeItem('oi_username');
    localStorage.removeItem('oi_role');
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setTraderId(null);
    setUsername('');
    setRole('TRADER');
    setActiveTraderId(null);
    setAvailableTraders([]);
    setWindows([]);
    setPendingLimitRequestsCount(0);
    setLimitRequestAlert(null);
  };

  const handleSelectTrader = (newTraderId: string) => {
    if (role !== 'ADMIN') return;
    setActiveTraderId(newTraderId);
  };

  const handleChangeMarketMode = async (newMode: 'RANDOM_WALK' | 'USER_DRIVEN') => {
    if (role !== 'ADMIN' || !token) return;
    const prevMode = marketMode;
    setMarketMode(newMode);
    try {
      const res = await fetch('/api/admin/market-mode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ mode: newMode }),
      });
      if (!res.ok) {
        console.error('[Admin Error] Failed to change market mode:', res.status, await res.text().catch(() => ''));
        setMarketMode(prevMode);
      }
    } catch (err) {
      console.error('[Admin Error] Network failure changing market mode:', err);
      setMarketMode(prevMode);
    }
  };

  // 7. Window Management Actions
  const bringToFocus = useCallback((id: string) => {
    setWindows((curr) => {
      const currentWin = curr.find((w) => w.id === id);
      if (!currentWin) return curr;

      const maxZ = curr.reduce((max, w) => Math.max(max, w.zIndex || 0), 10);
      const isSoleTop = currentWin.zIndex === maxZ && curr.filter((w) => w.zIndex === maxZ).length === 1;
      if (isSoleTop) {
        return curr;
      }

      const nextZ = maxZ + 1;
      return curr.map((w) => (w.id === id ? { ...w, zIndex: nextZ } : w));
    });
  }, []);

  const handleSpawnWidget = (type: WidgetType, customSymbol?: string) => {
    if (type === 'FILL_ALERT') {
      const existing = windows.find((w) => w.type === 'FILL_ALERT');
      if (existing) {
        bringToFocus(existing.id);
        if (existing.isMinimized) {
          setWindows((curr) =>
            curr.map((w) => (w.id === existing.id ? { ...w, isMinimized: false } : w))
          );
        }
        return;
      }
    }

    const id = `win_${type}_${Date.now()}`;
    const defaultSym = customSymbol || DEFAULT_INSTRUMENT;

    let title = '';
    let width = 450;
    let height = 360;

    switch (type) {
      case 'CHART':
        title = 'Trade Chart';
        width = 540;
        height = 360;
        break;
      case 'LADDER':
        title = 'DOM Depth Ladder';
        width = 380;
        height = 420;
        break;
      case 'ORDER_TICKET':
        title = 'Order Entry Ticket';
        width = 380;
        height = 440;
        break;
      case 'ORDER_BOOK':
        title = 'Order Book';
        width = 680;
        height = 380;
        break;
      case 'TAS':
        title = 'Time & Sales';
        width = 340;
        height = 360;
        break;
      case 'POSITION_BOOK':
        title = 'Position Book & P&L';
        width = 560;
        height = 340;
        break;
      case 'FILL_BOOK':
        title = 'Execution Fills Log';
        width = 460;
        height = 320;
        break;
      case 'FILL_ALERT':
        title = 'Fill Alert';
        width = 620;
        height = 320;
        break;
      case 'LIMITS':
        title = 'ROM Risk Controls';
        width = 440;
        height = 480;
        break;
    }

    setWindows((prev) => {
      const count = prev.length;
      const x = 30 + (count % 8) * 35;
      const y = 30 + (count % 8) * 30;
      const maxZ = prev.reduce((max, w) => Math.max(max, w.zIndex || 0), 10);
      const nextZ = maxZ + 1;

      const newWin: WindowInstance = {
        id,
        type,
        title,
        instrument: defaultSym,
        x,
        y,
        width,
        height,
        zIndex: nextZ,
        isMinimized: false,
        isMaximized: false,
      };
      return [...prev, newWin];
    });
  };

  const handleOpenRiskLimitsQueue = useCallback(() => {
    setLimitRequestAlert(null);
    setWindows((curr) => {
      const existing = curr.find((w) => w.type === 'LIMITS');
      const maxZ = curr.reduce((max, w) => Math.max(max, w.zIndex || 0), 10);
      const nextZ = maxZ + 1;

      if (existing) {
        return curr.map((w) =>
          w.id === existing.id
            ? { ...w, isMinimized: false, zIndex: nextZ, tab: 'REQUESTS_QUEUE' }
            : w
        );
      }

      const newWin: WindowInstance = {
        id: `win_LIMITS_${Date.now()}`,
        type: 'LIMITS',
        title: 'ROM Risk Controls',
        instrument: DEFAULT_INSTRUMENT,
        x: Math.max(30, Math.min(window.innerWidth - 480, 200)),
        y: Math.max(30, Math.min(window.innerHeight - 500, 100)),
        width: 440,
        height: 480,
        zIndex: nextZ,
        isMinimized: false,
        isMaximized: false,
        tab: 'REQUESTS_QUEUE'
      };
      return [...curr, newWin];
    });
  }, []);

  const handleCloseWindow = (id: string) => {
    setWindows((prev) => prev.filter((w) => w.id !== id));
  };

  const handleMinimizeWindow = (id: string) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, isMinimized: true } : w))
    );
  };

  const handleRestoreWindow = (id: string) => {
    setWindows((curr) => {
      const maxZ = curr.reduce((max, w) => Math.max(max, w.zIndex || 0), 10);
      const nextZ = maxZ + 1;
      return curr.map((w) => (w.id === id ? { ...w, isMinimized: false, zIndex: nextZ } : w));
    });
  };

  const handleToggleMaximize = (id: string) => {
    setWindows((prev) => {
      const maxZ = prev.reduce((max, w) => Math.max(max, w.zIndex || 0), 10);
      const nextZ = maxZ + 1;
      return prev.map((w) => {
        if (w.id !== id) return w;
        if (!w.isMaximized) {
          return {
            ...w,
            isMaximized: true,
            zIndex: nextZ,
            prevBounds: { x: w.x, y: w.y, width: w.width, height: w.height },
          };
        } else {
          return {
            ...w,
            isMaximized: false,
            zIndex: nextZ,
            x: w.prevBounds?.x ?? w.x,
            y: w.prevBounds?.y ?? w.y,
            width: w.prevBounds?.width ?? w.width,
            height: w.prevBounds?.height ?? w.height,
          };
        }
      });
    });
  };

  const handleInstrumentChange = (id: string, newSymbol: string) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, instrument: newSymbol } : w))
    );
  };

  const handleUpdatePosition = (id: string, x: number, y: number) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, x, y } : w))
    );
  };

  const handleUpdateSize = (id: string, width: number, height: number, x: number, y: number) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, width, height, x, y } : w))
    );
  };

  // 8. Quick Presets
  const handleApplyScalperLayout = () => {
    // Canvas dimensions calibrated for 1440p institutional desk cockpits
    const vw = typeof window !== 'undefined' ? window.innerWidth : 2560;
    const vh = typeof window !== 'undefined' ? (window.innerHeight - 44) : 1300;

    // Col 1 (DOM Ladder & Order Ticket): ~21% of usable width
    const colLadderW = Math.max(360, Math.round((vw - 50) * 0.21));

    // Row 1 remainder: Chart and Order Book
    const remRow1 = (vw - 40) - colLadderW;
    const chartW = Math.round(remRow1 * 0.475);
    const bookW = remRow1 - chartW - 10;

    // Row 2 remainder: Time & Sales, Fills Log, Position Book
    const remRow2 = (vw - 50) - colLadderW;
    const tasW = Math.round(remRow2 * 0.267);
    const fillsW = Math.round(remRow2 * 0.294);
    const posW = remRow2 - tasW - fillsW;

    const rowH = Math.max(385, Math.floor((vh - 30) / 2));

    const xLadder = 10;
    const xChart = xLadder + colLadderW + 10;
    const xBook = xChart + chartW + 10;

    const xTicket = 10;
    const xTas = xTicket + colLadderW + 10;
    const xFills = xTas + tasW + 10;
    const xPos = xFills + fillsW + 10;

    const y1 = 10;
    const y2 = y1 + rowH + 10;

    setWindows([
      // Row 1 - DOM Ladder, Trade Chart, Order Book
      {
        id: 'scalper_ladder',
        type: 'LADDER',
        title: 'DOM Depth Ladder',
        instrument: 'GC Dec27',
        x: xLadder,
        y: y1,
        width: colLadderW,
        height: rowH,
        zIndex: 11,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'scalper_chart',
        type: 'CHART',
        title: 'Trade Chart',
        instrument: 'GC Dec27',
        x: xChart,
        y: y1,
        width: chartW,
        height: rowH,
        zIndex: 12,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'scalper_book',
        type: 'ORDER_BOOK',
        title: 'Order Book',
        instrument: 'GC Dec27',
        x: xBook,
        y: y1,
        width: bookW,
        height: rowH,
        zIndex: 13,
        isMinimized: false,
        isMaximized: false,
      },

      // Row 2 - Order Entry Ticket, Time & Sales, Execution Fills Log, Position Book & P&L
      {
        id: 'scalper_ticket',
        type: 'ORDER_TICKET',
        title: 'Order Entry Ticket',
        instrument: 'GC Dec27',
        x: xTicket,
        y: y2,
        width: colLadderW,
        height: rowH,
        zIndex: 14,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'scalper_tas',
        type: 'TAS',
        title: 'Time & Sales',
        instrument: 'GC Dec27',
        x: xTas,
        y: y2,
        width: tasW,
        height: rowH,
        zIndex: 15,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'scalper_fill_book',
        type: 'FILL_BOOK',
        title: 'Execution Fills Log',
        instrument: 'GC Dec27',
        x: xFills,
        y: y2,
        width: fillsW,
        height: rowH,
        zIndex: 16,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'scalper_position_book',
        type: 'POSITION_BOOK',
        title: 'Position Book & P&L',
        instrument: 'GC Dec27',
        x: xPos,
        y: y2,
        width: posW,
        height: rowH,
        zIndex: 17,
        isMinimized: false,
        isMaximized: false,
      },
    ]);
  };

  const handleApplyMultiContractLayout = () => {
    // Dynamic canvas dimensions calibrated for 1440p (2560x1440) institutional desks
    const vw = typeof window !== 'undefined' ? window.innerWidth : 2560;
    const vh = typeof window !== 'undefined' ? (window.innerHeight - 44) : 1300;

    const col1W = Math.max(360, Math.round((vw - 50) * 0.201));
    const col2W = Math.max(280, Math.round((vw - 50) * 0.153));
    const col3W = Math.max(380, Math.round((vw - 50) * 0.203));
    const col4W = Math.max(700, (vw - 50) - col1W - col2W - col3W);

    const posW = Math.round(col4W * 0.655);
    const fillsW = col4W - posW - 10;

    const rowH = Math.max(385, Math.floor((vh - 30) / 2));

    const x1 = 10;
    const x2 = x1 + col1W + 10;
    const x3 = x2 + col2W + 10;
    const x4 = x3 + col3W + 10;
    const x5_fills = x4 + posW + 10;

    const y1 = 10;
    const y2 = y1 + rowH + 10;

    setWindows([
      // Row 1 - GC Dec27 (Gold)
      {
        id: 'multi_ladder_gc',
        type: 'LADDER',
        title: 'DOM Depth Ladder',
        instrument: 'GC Dec27',
        x: x1,
        y: y1,
        width: col1W,
        height: rowH,
        zIndex: 11,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_tas_gc',
        type: 'TAS',
        title: 'Time & Sales',
        instrument: 'GC Dec27',
        x: x2,
        y: y1,
        width: col2W,
        height: rowH,
        zIndex: 12,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_chart_gc',
        type: 'CHART',
        title: 'Trade Chart',
        instrument: 'GC Dec27',
        x: x3,
        y: y1,
        width: col3W,
        height: rowH,
        zIndex: 13,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_order_book',
        type: 'ORDER_BOOK',
        title: 'Order Book',
        instrument: 'GC Dec27',
        x: x4,
        y: y1,
        width: col4W,
        height: rowH,
        zIndex: 14,
        isMinimized: false,
        isMaximized: false,
      },

      // Row 2 - CL Dec27 (Crude Oil) + Execution & Position Blotters
      {
        id: 'multi_ladder_cl',
        type: 'LADDER',
        title: 'DOM Depth Ladder',
        instrument: 'CL Dec27',
        x: x1,
        y: y2,
        width: col1W,
        height: rowH,
        zIndex: 15,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_tas_cl',
        type: 'TAS',
        title: 'Time & Sales',
        instrument: 'CL Dec27',
        x: x2,
        y: y2,
        width: col2W,
        height: rowH,
        zIndex: 16,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_chart_cl',
        type: 'CHART',
        title: 'Trade Chart',
        instrument: 'CL Dec27',
        x: x3,
        y: y2,
        width: col3W,
        height: rowH,
        zIndex: 17,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_position_book',
        type: 'POSITION_BOOK',
        title: 'Position Book & P&L',
        instrument: 'GC Dec27',
        x: x4,
        y: y2,
        width: posW,
        height: rowH,
        zIndex: 18,
        isMinimized: false,
        isMaximized: false,
      },
      {
        id: 'multi_fill_book',
        type: 'FILL_BOOK',
        title: 'Execution Fills Log',
        instrument: 'GC Dec27',
        x: x5_fills,
        y: y2,
        width: fillsW,
        height: rowH,
        zIndex: 19,
        isMinimized: false,
        isMaximized: false,
      },
    ]);
  };

  const handleClearCanvas = () => {
    setWindows([]);
  };

  // 9. Trading Actions
  const handlePlaceOrder = (order: {
    instrument: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET';
    price: number;
    qty: number;
    tif: 'DAY' | 'GTC' | 'IOC' | 'FOK';
  }) => {
    if (!ws.isConnected) return;
    playOrderPlacedSound();
    ws.placeOrder({
      ...order,
      ...(role === 'ADMIN' && effectiveTraderId ? { traderId: effectiveTraderId } : {})
    } as any);
  };

  const handleCancelAll = (instrument?: string) => {
    const working = ws.orders.filter(
      (o) =>
        (o.status === 'WORKING' || o.status === 'SUBMITTED' || o.status === 'PARTIALLY_FILLED') &&
        (instrument && instrument !== 'ALL' ? o.instrument === instrument : true)
    );
    working.forEach((o) => ws.cancelOrder(o.id, o.instrument));
  };

  const handleFlattenPosition = (symbol: string, currentNetPos: number) => {
    if (currentNetPos === 0 || !ws.isConnected) return;
    playOrderPlacedSound();

    const side = currentNetPos > 0 ? 'SELL' : 'BUY';
    const qtyToClose = Math.abs(currentNetPos);
    const targetPrice =
      side === 'BUY'
        ? ws.tickers[symbol]?.ask || INSTRUMENTS[symbol]?.defaultPrice || 2650
        : ws.tickers[symbol]?.bid || INSTRUMENTS[symbol]?.defaultPrice || 2650;

    ws.placeOrder({
      instrument: symbol,
      side,
      type: 'MARKET',
      price: Number(targetPrice.toFixed(INSTRUMENTS[symbol]?.decimals || 2)),
      qty: qtyToClose,
      tif: 'IOC',
      ...(role === 'ADMIN' && effectiveTraderId ? { traderId: effectiveTraderId } : {})
    } as any);
  };

  // 10. Logged-Out Strict Workspace Isolation
  // When unauthenticated, the workspace and trading tools are completely unrendered
  if (!token) {
    return (
      <AuthModal
        isOpen={true}
        isFullScreen={true}
        onAuthSuccess={handleAuthSuccess}
      />
    );
  }

  const minimizedWindows = windows.filter((w) => w.isMinimized);

  return (
    <div className="h-screen w-screen bg-[#475569] text-terminal-text font-mono select-none flex flex-col overflow-hidden" style={{ backgroundColor: '#475569' }}>
      {/* Top Navigation Spawner Toolbar */}
      <WorkspaceToolbar
        isConnected={ws.isConnected}
        isReconnecting={ws.isReconnecting}
        token={token}
        username={username}
        role={role}
        traderId={traderId}
        availableTraders={availableTraders}
        activeTraderId={activeTraderId}
        pendingLimitRequestsCount={pendingLimitRequestsCount}
        marketMode={marketMode}
        onSelectTrader={handleSelectTrader}
        onOpenLimitRequests={handleOpenRiskLimitsQueue}
        onChangeMarketMode={handleChangeMarketMode}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        onLogout={handleLogout}
        onSpawnWidget={handleSpawnWidget}
        onApplyScalperLayout={handleApplyScalperLayout}
        onApplyMultiContractLayout={handleApplyMultiContractLayout}
        onClearCanvas={handleClearCanvas}
      />

      {/* Auth Modal (For in-session switching or account management) */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onAuthSuccess={handleAuthSuccess}
      />

      {/* Real-Time Admin Limit Increase Alert Toast Notification */}
      {role === 'ADMIN' && limitRequestAlert && (
        <div className="bg-slate-800 border-b border-slate-700 text-slate-200 text-xs px-4 py-2 flex items-center justify-between shadow-xl shrink-0 z-50 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2.5">
            <BellRing size={16} className="text-amber-400 animate-bounce" />
            <span>
              <b>Limit Request Alert:</b> Trader <span className="text-sky-300 font-black">"{limitRequestAlert.username || limitRequestAlert.traderId}"</span> requested limit increase for <b>{limitRequestAlert.instrument}</b> (Order Qty: {limitRequestAlert.reqMaxOrderQty}, Position: {limitRequestAlert.reqMaxPosition}, Notional: ${(Number(limitRequestAlert.reqMaxNotional) / 1000000).toFixed(1)}M)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenRiskLimitsQueue}
              className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-900 font-black text-xs rounded shadow transition active:scale-95 flex items-center gap-1"
            >
              <ShieldCheck size={13} />
              <span>Review Request</span>
            </button>
            <button
              onClick={() => setLimitRequestAlert(null)}
              className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700/60"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Risk Alert Banner */}
      {ws.riskAlert && (
        <div className="bg-terminal-sell text-white text-xs font-bold px-4 py-1.5 flex items-center justify-between shadow-lg shrink-0 z-50">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>{ws.riskAlert.message}</span>
            <span className="text-red-200 text-[10px]">[{ws.riskAlert.timestamp}]</span>
          </div>
          <button
            onClick={ws.clearRiskAlert}
            className="text-white hover:text-red-200 font-bold px-2 text-base"
          >
            ×
          </button>
        </div>
      )}

      {/* Main Multi-Window Canvas Area */}
      <main className="flex-1 relative overflow-auto bg-[#475569]" style={{ backgroundColor: '#475569' }}>
        <div
          className="relative"
          style={{
            width: canvasDimensions.width ? `${canvasDimensions.width}px` : '100%',
            height: canvasDimensions.height ? `${canvasDimensions.height}px` : '100%',
            minWidth: '100%',
            minHeight: '100%',
          }}
        >
          {/* Empty Canvas Prompt */}
          {windows.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 select-none pointer-events-none">
              <div className="bg-white/95 border border-terminal-border rounded-lg p-8 max-w-md shadow-lg pointer-events-auto">
                <div className="text-3xl mb-3">⚡</div>
                <h2 className="text-base font-bold text-terminal-accent uppercase tracking-wider mb-2">
                  Blank Trading Canvas
                </h2>
                <p className="text-xs text-terminal-muted mb-6 leading-relaxed">
                  Click any widget button in the top toolbar to spawn charts, DOM ladders, order tickets, order book, or real-time fill alerts.
                </p>

                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={handleApplyScalperLayout}
                    className="px-3 py-2 bg-terminal-buy hover:bg-terminal-buy-hover text-white text-xs font-bold rounded shadow transition active:scale-95"
                  >
                    ⚡ Launch Scalper Layout
                  </button>
                  <button
                    onClick={handleApplyMultiContractLayout}
                    className="px-3 py-2 bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold rounded shadow transition active:scale-95"
                  >
                    📊 Multi-Contract Grid
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Render Floating Windows */}
          {windows.map((win) => (
            <WindowWrapper
              key={win.id}
              window={win}
              onFocus={bringToFocus}
              onClose={handleCloseWindow}
              onMinimize={handleMinimizeWindow}
              onToggleMaximize={handleToggleMaximize}
              onInstrumentChange={handleInstrumentChange}
              onUpdatePosition={handleUpdatePosition}
              onUpdateSize={handleUpdateSize}
              onDragLive={handleDragLive}
              onDragEnd={handleDragEnd}
            >
              {win.type === 'CHART' && (
                <ChartWidget
                  instrument={win.instrument}
                  recentTrades={ws.recentTrades}
                />
              )}

              {win.type === 'LADDER' && (
                <LadderWidget
                  instrument={win.instrument}
                  depth={ws.depths[win.instrument]}
                  ticker={ws.tickers[win.instrument]}
                  orders={ws.orders}
                  recentTrades={ws.recentTrades}
                  onPlaceOrder={handlePlaceOrder}
                  onCancelOrder={ws.cancelOrder}
                  onCancelAll={() => handleCancelAll(win.instrument)}
                />
              )}

              {win.type === 'ORDER_TICKET' && (
                <OrderTicketWidget
                  instrument={win.instrument}
                  ticker={ws.tickers[win.instrument]}
                  depth={ws.depths[win.instrument]}
                  orders={ws.orders}
                  recentTrades={ws.recentTrades}
                  piqMap={ws.piqMap}
                  onPlaceOrder={handlePlaceOrder}
                  onCancelOrder={ws.cancelOrder}
                  onCancelAll={() => handleCancelAll(win.instrument)}
                />
              )}

              {win.type === 'ORDER_BOOK' && (
                <OrderBookWidget
                  instrument={win.instrument}
                  orders={ws.orders}
                  piqMap={ws.piqMap}
                  depths={ws.depths}
                  tickers={ws.tickers}
                  onCancelOrder={ws.cancelOrder}
                  onCancelAll={handleCancelAll}
                />
              )}

              {win.type === 'TAS' && (
                <TimeAndSalesWidget
                  instrument={win.instrument}
                  trades={ws.tradesBySymbol[win.instrument] || ws.recentTrades}
                />
              )}

              {win.type === 'POSITION_BOOK' && (
                <PositionBookWidget
                  positions={ws.positions}
                  tickers={ws.tickers}
                  onFlatten={handleFlattenPosition}
                />
              )}

              {win.type === 'FILL_BOOK' && (
                <FillBookWidget fills={ws.traderFills} orders={ws.orders} traderId={effectiveTraderId} />
              )}

              {win.type === 'FILL_ALERT' && (
                <FillAlertWidget
                  fills={ws.alertFills}
                  onClear={ws.clearAlertFills}
                />
              )}

              {win.type === 'LIMITS' && (
                <RiskLimitsWidget
                  traderId={effectiveTraderId}
                  role={role}
                  positions={ws.positions}
                  initialTab={win.tab}
                  liveLimitsUpdate={liveLimitsUpdate}
                />
              )}
            </WindowWrapper>
          ))}
        </div>

        {/* Minimized Dock Taskbar */}
        <DockTaskbar
          minimizedWindows={minimizedWindows}
          onRestore={handleRestoreWindow}
        />
      </main>
    </div>
  );
}