// Web Audio API context singleton
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

/**
 * 1. Order Placed Sound (Clean Metallic High-A6 Ping: 1760 Hz)
 * Fast, sharp feedback when an order is submitted.
 */
export function playOrderPlacedSound(): void {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1760.0, now); // Pure high A6 note

        gain.gain.setValueAtTime(0.45, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.12);
    } catch (err) {
        console.warn('[Audio] Failed to play order placed sound:', err);
    }
}

/**
 * 2. Institutional Execution Chime (Bright A-Major Triad: A5 -> C#6 -> E6)
 * Loud, crisp 3-tone chime played on fill.
 */
export function playFillChime(): void {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        const notes = [
            { freq: 880.0, offset: 0.0, duration: 0.28, gain: 0.45 },
            { freq: 1108.73, offset: 0.04, duration: 0.32, gain: 0.40 },
            { freq: 1318.51, offset: 0.08, duration: 0.45, gain: 0.42 },
        ];

        notes.forEach(({ freq, offset, duration, gain }) => {
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + offset);

            gainNode.gain.setValueAtTime(gain, now + offset);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + offset + duration);

            osc.connect(gainNode);
            gainNode.connect(ctx.destination);

            osc.start(now + offset);
            osc.stop(now + offset + duration);
        });
    } catch (err) {
        console.warn('[Audio] Failed to play fill chime:', err);
    }
}

/**
 * 3. Risk Rejection Low Buzz (130.81 Hz C3 Sawtooth)
 * Played when ROM rejects an order due to risk limit breach.
 */
export function playRejectBuzz(): void {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(130.81, now);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.22);
    } catch (err) {
        console.warn('[Audio] Failed to play reject buzz:', err);
    }
}