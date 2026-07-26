/**
 * CameraScanner — camera-based barcode scanner modal.
 *
 * Uses the ZXing browser library to read barcodes from the device camera.
 * When a barcode is detected it:
 *   1. Plays a short beep via the Web Audio API (no audio file needed)
 *   2. Calls onScan(barcodeText)
 *   3. Closes itself via onClose()
 *
 * Props:
 *   isOpen   — whether to show the modal
 *   onClose  — called when the user clicks Close, or after a successful scan
 *   onScan   — called with the raw barcode string when a barcode is detected
 *
 * Device handling:
 *   - On first open, the component lists all available video devices.
 *   - If there is more than one camera (e.g. front + back on a tablet or phone),
 *     a "Switch camera" button appears.
 *   - Camera permission denied → shows a clear error message instead of crashing.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function CameraScanner({ isOpen, onClose, onScan }) {
  const videoRef             = useRef(null);
  const readerRef            = useRef(null);     // holds the ZXing reader instance
  const [devices, setDevices]           = useState([]);      // list of camera devices
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(true);

  // ── Enumerate cameras once when the modal opens ──────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setLoading(true);

    // Dynamically import ZXing so it is not bundled into the main chunk —
    // it is only needed when the camera modal is opened.
    import('@zxing/library').then(({ BrowserMultiFormatReader }) => {
      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;

      reader.listVideoInputDevices().then((videoDevices) => {
        if (!videoDevices || videoDevices.length === 0) {
          setError('No camera found on this device. Please use a USB barcode scanner instead.');
          setLoading(false);
          return;
        }
        setDevices(videoDevices);
        // Default to the last camera (usually the back camera on phones/tablets)
        setSelectedDeviceId(videoDevices[videoDevices.length - 1].deviceId);
        setLoading(false);
      }).catch(() => {
        setError('Camera access denied. Please allow camera access in browser settings, or use a USB scanner.');
        setLoading(false);
      });
    }).catch(() => {
      setError('Could not load the barcode scanner library. Please refresh and try again.');
      setLoading(false);
    });

    // Cleanup: reset ZXing when the modal closes
    return () => {
      readerRef.current?.reset();
      readerRef.current = null;
    };
  }, [isOpen]);

  // ── Start scanning whenever selectedDeviceId changes ────────────────────
  useEffect(() => {
    if (!isOpen || !selectedDeviceId || !videoRef.current || loading) return;

    // Stop any previous scan session before starting a new one
    readerRef.current?.reset();

    import('@zxing/library').then(({ BrowserMultiFormatReader }) => {
      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;

      reader.decodeFromVideoDevice(
        selectedDeviceId,
        videoRef.current,
        (result, err) => {
          if (result) {
            // ── Beep: short 1800 Hz tone for 100 ms ──
            try {
              const ctx  = new AudioContext();
              const osc  = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.frequency.value = 1800;
              gain.gain.setValueAtTime(0.3, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.1);
              // Clean up AudioContext after the beep finishes
              setTimeout(() => ctx.close(), 300);
            } catch (_) { /* audio not critical */ }

            onScan(result.getText());
            reader.reset();
            onClose();
          }
          // err is set on every frame where no barcode was found — that is
          // normal continuous scanning behaviour; we only act on result.
        },
      );
    });

    return () => {
      readerRef.current?.reset();
    };
  }, [isOpen, selectedDeviceId, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Switch between available cameras ────────────────────────────────────
  function switchCamera() {
    if (devices.length < 2) return;
    const currentIdx = devices.findIndex(d => d.deviceId === selectedDeviceId);
    const nextIdx    = (currentIdx + 1) % devices.length;
    setSelectedDeviceId(devices[nextIdx].deviceId);
  }

  if (!isOpen) return null;

  // ── Render via portal so it sits above all other content ────────────────
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'rgba(255,255,255,0.10)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(255,255,255,0.20)',
          borderRadius: 'var(--radius-xl)',
          padding: 24,
          width: 460,
          maxWidth: '95vw',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        {/* Header */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>
            📷 Scan Barcode
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: 8, color: '#fff', fontSize: 18, lineHeight: 1,
              padding: '2px 8px', cursor: 'pointer',
            }}
          >×</button>
        </div>

        {/* Error state */}
        {error && (
          <div style={{
            background: 'rgba(244,63,94,0.15)', border: '1px solid rgba(225,29,72,0.35)',
            borderRadius: 'var(--radius)', padding: '12px 16px',
            color: '#fecdd3', fontSize: 14, textAlign: 'center', lineHeight: 1.5,
            width: '100%',
          }}>
            {error}
          </div>
        )}

        {/* Loading spinner */}
        {loading && !error && (
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>
            Starting camera…
          </div>
        )}

        {/* Camera viewfinder */}
        {!error && (
          <div style={{
            position: 'relative', width: 400, height: 300,
            maxWidth: '100%', borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            border: '2px solid rgba(16,185,129,0.60)',
            background: '#000',
          }}>
            <video
              ref={videoRef}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              muted
              playsInline
            />

            {/* Animated green scan line */}
            <div style={{
              position: 'absolute', left: 0, right: 0, height: 2,
              background: 'linear-gradient(90deg, transparent, #10b981, #10b981, transparent)',
              boxShadow: '0 0 8px 2px rgba(16,185,129,0.7)',
              animation: 'scanLine 1.8s ease-in-out infinite',
            }} />

            {/* Corner guides — give the pharmacist a clear aiming target */}
            {[
              { top: 12, left: 12,  borderTop: '3px solid #10b981', borderLeft:  '3px solid #10b981' },
              { top: 12, right: 12, borderTop: '3px solid #10b981', borderRight: '3px solid #10b981' },
              { bottom: 12, left: 12,  borderBottom: '3px solid #10b981', borderLeft:  '3px solid #10b981' },
              { bottom: 12, right: 12, borderBottom: '3px solid #10b981', borderRight: '3px solid #10b981' },
            ].map((s, i) => (
              <div key={i} style={{ position: 'absolute', width: 20, height: 20, ...s }} />
            ))}
          </div>
        )}

        {/* Instruction */}
        {!error && (
          <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, textAlign: 'center', margin: 0 }}>
            Point camera at barcode — it scans automatically
          </p>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
          {devices.length > 1 && (
            <button
              onClick={switchCamera}
              style={{
                flex: 1, padding: '10px', fontSize: 13, fontWeight: 500,
                background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)',
                borderRadius: 'var(--radius)', color: '#fff', cursor: 'pointer',
              }}
            >
              ↺ Switch camera
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '10px', fontSize: 13, fontWeight: 600,
              background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.30)',
              borderRadius: 'var(--radius)', color: '#fff', cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
