// Number formatting for readouts — always legible, never scientific.

export function fmtDistance(m: number): string {
  if (!isFinite(m)) return '—';
  const abs = Math.abs(m);
  if (abs < 10_000) return `${m.toFixed(0)} m`;
  if (abs < 10_000_000) return `${(m / 1000).toFixed(1)} km`;
  return `${(m / 1000).toFixed(0)} km`;
}

export function fmtSpeed(ms: number): string {
  if (!isFinite(ms)) return '—';
  return ms < 3000 ? `${ms.toFixed(0)} m/s` : `${(ms / 1000).toFixed(2)} km/s`;
}

export function fmtMass(kg: number): string {
  return kg < 10_000 ? `${kg.toFixed(0)} kg` : `${(kg / 1000).toFixed(1)} t`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s) || isNaN(s)) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtDeltaV(ms: number): string {
  return `${Math.round(ms).toLocaleString('en-US')} m/s`;
}
