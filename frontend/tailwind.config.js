/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                terminal: {
                    bg: '#475569',          // Medium slate grey desktop canvas (darker than widgets, not black)
                    surface: '#e2e5eb',     // Window chrome and secondary surface
                    card: '#f4f6f9',        // Panels and table cards
                    cardLight: '#ffffff',   // Crisp white content card
                    border: '#b4bcc8',      // Crisp grid lines and window borders
                    borderLight: '#cbd5e1', // Subtle interior divider
                    hover: '#e2e7ee',       // Hover row highlight
                    accent: '#1d70b8',      // Professional focus/accent blue
                    buy: '#1d70b8',         // Bid / Buy solid soft blue
                    'buy-hover': '#165c97',
                    'buy-subtle': '#dbeafe',// Light blue badge/selection
                    sell: '#c53030',        // Ask / Sell solid soft brick red
                    'sell-hover': '#a82323',
                    'sell-subtle': '#fee2e2',// Light red badge/selection
                    working: '#b45309',     // Working order amber text
                    piqGreen: '#15803d',    // Head of line green
                    piqAmber: '#b45309',    // Queue rank amber
                    text: '#0f172a',        // Crisp primary dark text
                    muted: '#475569',       // Secondary muted headers
                    dim: '#64748b',         // Inactive element text
                }
            },
            fontFamily: {
                mono: ['JetBrains Mono', 'Fira Code', 'Roboto Mono', 'ui-monospace', 'monospace'],
            }
        },
    },
    plugins: [],
};