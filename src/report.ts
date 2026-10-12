// The morning report: the ledger read back in one breath. Pure text from a Ledger, so the
// MCP tool, the simulated Alexa+ page and the tests share one wording. Plain, declarative, no
// superlatives; in dry run it says so instead of claiming anything was switched.
import {
  allActionsDone,
  zoneLabel,
  type Ledger,
  type LedgerLine,
  type LedgerSource,
} from './ledger.ts';
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

// The service that must have completed for each level to count as done.
const LEVEL_SERVICE: Record<number, string> = { 2: 'turn_on', 3: 'play_clip', 4: 'open_valve' };

// What the porch did, level by level, claiming only what a completed action backs up. Level 1
// (the phone alert) leaves no intent row, so it is stated as the level reached, nothing more.
function didClauses(l: LedgerLine, isExterior?: (entityId: string) => boolean): string[] {
  if (l.profile === 'wildlife') {
    const ran = l.actions.some((a) => a.service === 'open_valve' && a.status === 'done');
    return [ran ? 'ran the sprinkler' : 'logged it'];
  }
  const out: string[] = [];
  for (const e of l.levels) {
    if (e.level === 1) continue;
    const at = atSeconds(e.dwell_ms);
    // The completed action must be the right service, and for the outside light an exterior
    // entity (an interior light also uses turn_on).
    const ok = e.done.some(
      (d) =>
        d.service === LEVEL_SERVICE[e.level] &&
        (e.level !== 2 || !isExterior || isExterior(d.entity_id)),
    );
    // An incident still running may simply not have reached this step yet: say nothing.
    if (!ok && l.stop_reason === 'still active') continue;
    if (e.level === 2)
      out.push(
        ok ? `switched on the outside light${at}` : `could not switch on the outside light${at}`,
      );
    if (e.level === 3)
      out.push(
        ok ? `${l.spoken_text ? 'spoke' : 'played a sound'}${at}` : `could not play a sound${at}`,
      );
    if (e.level === 4) out.push(ok ? `ran the sprinkler${at}` : `could not run the sprinkler${at}`);
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
  if (r.startsWith('expected')) {
    return l.profile === 'wildlife'
      ? 'A person was in the yard, so it stopped'
      : 'It turned out to be expected';
  }
  if (r === 'reclassified harmless') return 'It turned out to be nothing';
  return `It ended${at}: ${r}`;
}

export function handledSentence(
  l: LedgerLine,
  tz: string,
  isExterior?: (entityId: string) => boolean,
): string {
  const where = `in the ${zoneLabel(l.zone)} at ${spokenTime(l.ts_ring, tz)}`;
  if (l.dry_run) {
    const lv = l.profile === 'wildlife' ? 'a wildlife run' : `level ${l.level}`;
    return `${subject(l.what)} ${where}, ${lv}.`;
  }
  // Never claim an output that did not go through: say what was reached and that actions failed.
  if (!allActionsDone(l)) {
    const reached = l.profile === 'wildlife' ? 'tried a wildlife run' : `reached level ${l.level}`;
    return `${subject(l.what)} ${where}. It ${reached}, but some actions did not complete. ${endClause(l, tz)}.`;
  }
  const did = didClauses(l, isExterior);
  const first = l.levels.length ? 'It reached level ' + l.level + '.' : '';
  const middle = did.length ? ` It ${joinClauses(did)}.` : first ? ` ${first}` : '';
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
    source?: LedgerSource;
  },
): NightReport {
  const { counts, lines } = ledger;
  const handled = lines.filter((l) => l.kind === 'handled');
  // A replay or sandbox night is never "tonight". Its label is added once, by the MCP layer that
  // serves every answer, so the wording here only avoids the live-sounding phrase.
  const nonLive = opts.source !== undefined && opts.source !== 'clip' && opts.source !== 'live';
  const prefix = span.inProgress && !nonLive ? 'So far tonight. ' : '';
  const parts: string[] = [];
  if (counts.events === 0) {
    parts.push(
      `No events. Silent all night, ${spokenClock(opts.start)} to ${spokenClock(opts.end)}.`,
    );
  } else {
    parts.push(`${cap(numberWord(counts.events))} ${counts.events === 1 ? 'event' : 'events'}.`);
    // Blind and held events are counted as silent (nothing acted) but never called "silent":
    // the report says what actually happened to them.
    const plainSilent = counts.silent - counts.blind - counts.held - counts.expected;
    if (counts.handled === 0 && plainSilent === counts.events) parts.push('All silent.');
    else if (plainSilent > 0) parts.push(`${cap(numberWord(plainSilent))} silent.`);
    if (counts.handled > 0) {
      // The first follows the colon; the rest start new sentences.
      const sentences = handled.map((l, i) => {
        const t = handledSentence(l, opts.timezone, opts.isExterior);
        return i === 0 ? t : cap(t);
      });
      parts.push(`${cap(numberWord(counts.handled))} handled: ${sentences.join(' ')}`);
    }
    if (counts.expected > 0) {
      parts.push(`${cap(numberWord(counts.expected))} expected, so it stayed quiet.`);
    }
    if (counts.held > 0) {
      parts.push(
        `${cap(numberWord(counts.held))} held back (kill switch, cooldown or old evidence), nothing acted on.`,
      );
    }
    if (counts.blind > 0) {
      parts.push(
        `${cap(numberWord(counts.blind))} could not be seen: the camera video is encrypted.`,
      );
    }
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
      sentence: handledSentence(l, opts.timezone, opts.isExterior),
    })),
  };
}
