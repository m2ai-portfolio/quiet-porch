// The night window as a concrete [from, to] span of epoch ms in the configured time zone.
// "Last night" means the most recent window that has started, finished or still running, so a
// morning question and a 2 a.m. question both land on the right night. No dependencies:
// Intl does the zone arithmetic, and DST nights come out right because both ends are resolved
// as local wall-clock times, not as start + a fixed duration.

export interface NightSpan {
  from: number;
  to: number;
  inProgress: boolean;
}

interface LocalDate {
  y: number;
  m: number; // 1..12
  d: number;
}

function partsOf(epoch: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

// Local wall time minus the true epoch: the zone's UTC offset at that instant.
function offsetAt(epoch: number, timeZone: string): number {
  const p = partsOf(epoch, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(epoch / 1000) * 1000;
}

// Epoch of a local wall-clock time. Two passes settle the offset across a DST change.
function zonedEpoch(day: LocalDate, hhmm: string, timeZone: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  const asUtc = Date.UTC(day.y, day.m - 1, day.d, Number(m[1]), Number(m[2]));
  let epoch = asUtc - offsetAt(asUtc, timeZone);
  epoch = asUtc - offsetAt(epoch, timeZone);
  return epoch;
}

function shiftDay(day: LocalDate, by: number): LocalDate {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + by));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function latestNightWindow(
  now: number,
  start: string,
  end: string,
  timeZone: string,
): NightSpan {
  const today = partsOf(now, timeZone);
  const base: LocalDate = { y: today.y, m: today.m, d: today.d };
  const wraps = end <= start; // "HH:MM" strings compare correctly as text
  for (const back of [0, -1, -2]) {
    const day = shiftDay(base, back);
    const from = zonedEpoch(day, start, timeZone);
    if (from > now) continue;
    const to = zonedEpoch(shiftDay(day, wraps ? 1 : 0), end, timeZone);
    return { from, to, inProgress: now < to };
  }
  throw new Error('night window: no window found in the last three days');
}

// "20:00" -> "8 PM", "06:30" -> "6:30 AM", for spoken answers.
export function spokenClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// Epoch ms -> "2:14" in the zone (spoken: no AM/PM, the night makes it clear).
export function spokenTime(epoch: number, timeZone: string): string {
  const p = partsOf(epoch, timeZone);
  const hour = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${hour}:${String(p.mi).padStart(2, '0')}`;
}

// Epoch ms -> "02:14:07" in the zone, for the ledger.
export function logTime(epoch: number, timeZone: string): string {
  const p = partsOf(epoch, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(p.h)}:${two(p.mi)}:${two(p.s)}`;
}

// Epoch ms -> "2026-10-08" in the zone.
export function localDate(epoch: number, timeZone: string): string {
  const p = partsOf(epoch, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
