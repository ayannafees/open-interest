import { useCallback } from 'react';
import { playFillChime, playOrderPlacedSound, playRejectBuzz } from '../utils/audio';

/**
 * React Hook for triggering trader audio alerts.
 */
export function useAudioAlerts() {
    const triggerOrderPlacedSound = useCallback(() => {
        playOrderPlacedSound();
    }, []);

    const triggerFillSound = useCallback(() => {
        playFillChime();
    }, []);

    const triggerRejectSound = useCallback(() => {
        playRejectBuzz();
    }, []);

    return {
        triggerOrderPlacedSound,
        triggerFillSound,
        triggerRejectSound,
    };
}