export type WidgetType =
    | 'CHART'
    | 'LADDER'
    | 'ORDER_TICKET'
    | 'ORDER_BOOK'
    | 'TAS'
    | 'POSITION_BOOK'
    | 'FILL_BOOK'
    | 'LIMITS'
    | 'FILL_ALERT';

export interface WindowInstance {
    id: string;
    type: WidgetType;
    title: string;
    instrument: string; // Independent product per window
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    isMinimized: boolean;
    isMaximized: boolean;
    tab?: 'LIMITS' | 'REQUEST_FORM' | 'REQUESTS_QUEUE';
    prevBounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}