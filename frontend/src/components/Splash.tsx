// Animated runner shown while the app is loading. The limb/bob/ground
// animations live in index.css (`.runner-*`); joints are rotated about
// view-box coordinates, so keep the SVG geometry and the CSS origins in sync.
export default function Splash({ message, fullScreen = false }: { message?: string; fullScreen?: boolean }) {
  return (
    <div className={`runner-splash${fullScreen ? ' runner-splash--full' : ''}`} role="status" aria-live="polite">
      <svg viewBox="0 0 120 120" width={120} height={120} aria-hidden="true"
        stroke="var(--orange)" strokeWidth={7} strokeLinecap="round" fill="none">
        <g className="runner-bob">
          <Arm far />
          <Leg far />
          <line x1={60} y1={36} x2={54} y2={64} />
          <circle cx={64} cy={22} r={8} fill="var(--orange)" stroke="none" />
          <Leg />
          <Arm />
        </g>
        <line className="runner-ground" x1={0} y1={112} x2={120} y2={112}
          stroke="var(--border)" strokeWidth={3} strokeDasharray="14 10" />
      </svg>
      {message && <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{message}</p>}
      {!message && <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>Loading…</span>}
    </div>
  );
}

function Leg({ far = false }: { far?: boolean }) {
  return (
    <g className={`runner-thigh${far ? ' runner-far' : ''}`}>
      <line x1={54} y1={64} x2={54} y2={84} />
      <g className="runner-shin">
        <line x1={54} y1={84} x2={54} y2={104} />
      </g>
    </g>
  );
}

function Arm({ far = false }: { far?: boolean }) {
  return (
    <g className={`runner-arm${far ? ' runner-far' : ''}`}>
      <line x1={60} y1={36} x2={60} y2={50} />
      <line x1={60} y1={50} x2={60} y2={62} transform="rotate(-80 60 50)" />
    </g>
  );
}
