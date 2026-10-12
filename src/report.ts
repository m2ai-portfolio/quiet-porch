// The morning report: the ledger read back in one breath (F3). Pure text from a Ledger, so the
// MCP tool, the simulated Alexa+ page and the tests share one wording. Plain, declarative, no
// superlatives; in dry run it says so instead of claiming anything was switched.
import { zoneLabel, type Ledger, type LedgerLine } from './ledger.ts';
import { spokenClock, spokenTime, type NightSpan } from './nightwindow.ts';

const SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
]; // prettier-ignore

export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 20 ? SMALL[n] : String(n);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function subject(what: string): string {
  if (what === 'person') return 'a person';
  if (what === 'nothing' || what === 'unreadable') return 'something';
  return /^[aeiou]/.test(what) ? `an ${what}` : `a ${what}`;
}

function atSeconds(ms: number | null): string {
  return ms === null ? '' : ` at ${Math.round(ms / 1000)} seconds`;
}

// What the porch did, from the levels earned and the actions logged.
function didClauses(l: LedgerLine): string[] {
  if (l.profile === 'wildlife') {
    const ran = l.actions.some((a) => a.service === 'open_valve');
    return [ran ? 'ran the sprinkler' : 'logged it'];
  }
  const out: string[] = [];
  for (const e of l.levels) {
    if (e.level === 1) out.push('alerted you at once');
    if (e.level === 2) out.push(`switched on the outside light${atSeconds(e.dwell_ms)}`);
    if (e.level === 3)
      out.push(`${l.spoken_text ? 'spoke' : 'played a sound'}${atSeconds(e.dwell_ms)}`);
    if (e.level === 4) out.push(`ran the sprinkler${atSeconds(e.dwell_ms)}`);
  }
  return out;
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function endClause(l: LedgerLine, tz: string): string {
  const time = l.stopped_at === null ? null : spokenTime(l.stopped_at, tz);
  const at = time ? ` at ${time}` : '';
  const r = l.stop_reason;
  if (r === 'still active') return 'It is still going';
  if (r === 'next frame empty') return time ? `The person was gone by ${time}` : 'The person left';
  if (r.startsWith('stood down')) return `You stood it down${at}`;
  if (r.startsWith('expected')) return 'It turned out to be expected';
  if (r === 'reclassified harmless') return 'It turned out to be nothing';
  return `It ended${at}: ${r}`;
}

export function handledSentence(l: LedgerLine, tz: string): string {
  const where = `in the ${zoneLabel(l.zone)} at ${spokenTime(l.ts_ring, tz)}`;
  if (l.dry_run) {
    const lv = l.profile === 'wildlife' ? 'a wildlife run' : `level ${l.level}`;
    return `${subject(l.what)} ${where}, ${lv}.`;
  }
  const did = didClauses(l);
  const middle = did.length ? ` It ${joinClauses(did)}.` : '';
  return `${subject(l.what)} ${where}.${middle} ${endClause(l, tz)}.`;
}

export interface NightReport {
  text: string;
  window: { from: number; to: number; in_progress: boolean };
  counts: Ledger['counts'];
  handled: { incident_id: number | null; ts_ring: number; sentence: string }[];
}

export function nightReport(
  ledger: Ledger,
  span: NightSpan,
  opts: {
    timezone: string;
    start: string;
    end: string;
    dryRun: boolean;
    isExterior?: (entityId: string) => boolean;
  },
): NightReport {
  const { counts, lines } = ledger;
  const handled = lines.filter((l) => l.kind === 'handled');
  const prefix = span.inProgress ? 'So far tonight. ' : '';
  const parts: string[] = [];
  if (counts.events === 0) {
    parts.push(
      `No events. Silent all night, ${spokenClock(opts.start)} to ${spokenClock(opts.end)}.`,
    );
  } else {
    parts.push(`${cap(numberWord(counts.events))} ${counts.events === 1 ? 'event' : 'events'}.`);
    if (counts.handled === 0) parts.push('All silent.');
    else {
      parts.push(`${cap(numberWord(counts.silent))} silent.`);
      // The first follows the colon; the rest start new sentences.
      const sentences = handled.map((l, i) => {
        const t = handledSentence(l, opts.timezone);
        return i === 0 ? t : cap(t);
      });
      parts.push(`${cap(numberWord(counts.handled))} handled: ${sentences.join(' ')}`);
    }
    if (counts.expected > 0)
      parts.push(`${cap(numberWord(counts.expected))} expected, so it stayed quiet.`);
    if (counts.blind > 0)
      parts.push(
        `${cap(numberWord(counts.blind))} could not be seen: the camera video is encrypted.`,
      );
  }
  if (opts.dryRun) {
    parts.push('Quiet Porch is in dry run, so nothing was actually switched.');
  } else if (counts.handled > 0 && opts.isExterior) {
    const outside = handled.some((l) => l.actions.some((a) => opts.isExterior!(a.entity_id)));
    if (!outside) parts.push('Nothing was switched outside.');
  }
  return {
    text: prefix + parts.join(' '),
    window: { from: span.from, to: span.to, in_progress: span.inProgress },
    counts,
    handled: handled.map((l) => ({
      incident_id: l.incident_id,
      ts_ring: l.ts_ring,
      sentence: handledSentence(l, opts.timezone),
    })),
  };
}
