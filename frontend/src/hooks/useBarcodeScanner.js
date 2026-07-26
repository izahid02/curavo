/**
 * useBarcodeScanner — detects USB barcode scanner input (keyboard-wedge mode).
 *
 * A USB scanner in keyboard-wedge mode behaves like a keyboard that types
 * characters very quickly (< 50 ms between each keystroke) and ends with
 * an Enter key.  Normal human typing is much slower (usually > 150 ms
 * between keystrokes).
 *
 * How it works:
 *   1. Listen for every keydown event on the window.
 *   2. Track the time between consecutive keystrokes.
 *   3. If the gap resets (> 100 ms), start a fresh buffer.
 *   4. When Enter arrives and the buffer has ≥ 6 characters, call onScan().
 *   5. Auto-flush the buffer after 500 ms (handles scanners that don't send
 *      Enter — rare, but some industrial scanners omit it).
 *
 * Props:
 *   onScan(barcode)  — called with the scanned string (without the Enter)
 *   enabled          — set to false to pause listening (e.g. while camera
 *                      modal is open, so the two methods don't conflict)
 */
import { useEffect, useRef, useCallback } from 'react';

export function useBarcodeScanner({ onScan, enabled = true }) {
  const bufferRef      = useRef('');
  const lastKeyTimeRef = useRef(0);
  const timerRef       = useRef(null);

  const handleKeyDown = useCallback((e) => {
    if (!enabled) return;

    const now           = Date.now();
    const timeSinceLast = now - lastKeyTimeRef.current;
    lastKeyTimeRef.current = now;

    // Gap > 100 ms means this is the start of a new scan (or human typing)
    if (timeSinceLast > 100) {
      bufferRef.current = '';
    }

    if (e.key === 'Enter') {
      const barcode = bufferRef.current.trim();
      bufferRef.current = '';
      // Require at least 6 chars — shorter strings are likely accidental keypresses
      if (barcode.length >= 6) {
        e.preventDefault();  // stop any form submission that might be listening
        onScan(barcode);
      }
      return;
    }

    // Only collect printable single characters (ignore Shift, Alt, F-keys, etc.)
    if (e.key.length === 1) {
      bufferRef.current += e.key;
    }

    // Safety flush: if no Enter arrives within 500 ms, discard the buffer.
    // This prevents stale partial scans from accidentally merging with the
    // next scan when a scanner mis-fires without sending Enter.
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      bufferRef.current = '';
    }, 500);

  }, [enabled, onScan]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timerRef.current);
    };
  }, [handleKeyDown]);
}
