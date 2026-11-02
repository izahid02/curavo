import { useEffect, useState } from 'react'

/**
 * Full-screen loading screen shown while the Python backend sidecar starts up
 * inside the Tauri desktop app.
 *
 * App.jsx renders this whenever `backendReady` is false.  When Rust emits the
 * "backend-ready" event, App.jsx flips that flag and swaps this out for the
 * real app — so this component just needs to look calm while it waits.
 *
 * In the browser (web dev) there is no backend to wait for, so App.jsx never
 * shows this at all.
 */
export default function SplashScreen() {
  const [stage, setStage] = useState('starting')
  const [dots, setDots] = useState('')

  useEffect(() => {
    // Animate the trailing dots so the screen never looks frozen.
    const interval = setInterval(() => {
      setDots(d => (d.length >= 3 ? '' : d + '.'))
    }, 500)

    // After 3s, switch the message so a slow first-run (DB creation) still
    // feels like progress rather than a hang.
    const timer = setTimeout(() => setStage('almost'), 3000)

    return () => {
      clearInterval(interval)
      clearTimeout(timer)
    }
  }, [])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #e0e7ff 0%, #f0f9ff 50%, #f0fdf4 100%)'
    }}>
      {/* Floating orbs — echoes the main app's glassmorphism background */}
      <div style={{
        position: 'absolute', width: '300px', height: '300px',
        borderRadius: '50%', top: '10%', right: '15%',
        background: 'radial-gradient(circle, rgba(99,102,241,0.15), transparent)',
        filter: 'blur(40px)'
      }}/>
      <div style={{
        position: 'absolute', width: '250px', height: '250px',
        borderRadius: '50%', bottom: '15%', left: '10%',
        background: 'radial-gradient(circle, rgba(16,185,129,0.15), transparent)',
        filter: 'blur(40px)'
      }}/>

      {/* Logo */}
      <div style={{
        width: '80px', height: '80px', borderRadius: '20px',
        overflow: 'hidden', marginBottom: '24px',
        boxShadow: '0 8px 32px rgba(99,102,241,0.2)'
      }}>
        <img src="/curavo-logo.svg" alt="Curavo"
             style={{ width: '100%', height: '100%', display: 'block' }}/>
      </div>

      {/* App name */}
      <h1 style={{
        fontSize: '28px', fontWeight: 800,
        color: '#1e1b4b', margin: '0 0 8px',
        fontFamily: 'Outfit, sans-serif',
        letterSpacing: '-0.02em'
      }}>
        Curavo
      </h1>
      <p style={{
        fontSize: '13px', color: '#6366f1',
        fontWeight: 600, letterSpacing: '0.1em',
        textTransform: 'uppercase', margin: '0 0 48px'
      }}>
        Pharmacy Management
      </p>

      {/* Loading indicator */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: '12px'
      }}>
        <div style={{
          width: '36px', height: '36px',
          border: '3px solid rgba(99,102,241,0.2)',
          borderTopColor: '#6366f1',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite'
        }}/>
        <p style={{
          fontSize: '14px', color: '#64748b',
          margin: 0, fontFamily: 'Outfit, sans-serif'
        }}>
          {stage === 'starting'
            ? `Starting up${dots}`
            : `Almost ready${dots}`}
        </p>
      </div>

      {/* Footer */}
      <p style={{
        position: 'absolute', bottom: '24px',
        fontSize: '11px', color: '#94a3b8',
        margin: 0, fontFamily: 'Outfit, sans-serif'
      }}>
        Powered by ARZ Technologies
      </p>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
