// Step 1 probe readout: summarize frame-probe.jsonl by sub_type (read-only).
// Usage: node scripts/probe-readout.ts [path] (default ~/.local/state/quiet-porch/frame-probe.jsonl)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Attempt {
  status: number;
  error_code?: string;
  frame_minus_event_ms?: number;
}
interface FollowUp {
  offset_ms: number;
  requested_ts: number;
  status: number;
  frame_minus_requested_ms?: number;
}
interface Row {
  logged_at: string;
  device_id: string;
  sub_type: string;
  event_ts: number;
  received_after_event_ms: number;
  attempts?: Attempt[];
  ready_after_event_ms?: number;
  follow_ups?: FollowUp[];
}

const path = process.argv[2] ?? join(homedir(), '.local/state/quiet-porch/frame-probe.jsonl');
const rows = readFileSync(path, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Row);

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
};
const spread = (a: number[]) =>
  a.length
    ? `min ${Math.min(...a)} / p50 ${pct(a, 0.5)} / p90 ${pct(a, 0.9)} / max ${Math.max(...a)}`
    : '-';
const tally = (keys: string[]) => {
  const t: Record<string, number> = {};
  for (const k of keys) t[k] = (t[k] ?? 0) + 1;
  return JSON.stringify(t);
};

console.log(`rows ${rows.length}, ${rows[0]?.logged_at} to ${rows.at(-1)?.logged_at}`);
for (const st of [...new Set(rows.map((r) => r.sub_type))]) {
  const g = rows.filter((r) => r.sub_type === st);
  const ready = g.flatMap((r) => (r.ready_after_event_ms == null ? [] : [r.ready_after_event_ms]));
  const ok = g.flatMap((r) => (r.attempts ?? []).filter((a) => a.status === 200));
  console.log(`\n${st}: n=${g.length} devices=${tally(g.map((r) => r.device_id.slice(-8)))}`);
  console.log(`  received_after_event_ms ${spread(g.map((r) => r.received_after_event_ms))}`);
  console.log(
    `  frame ready ${ready.length}/${g.length}, within 5 s ${ready.filter((m) => m <= 5000).length}/${g.length}`,
  );
  console.log(`  ready_after_event_ms ${spread(ready)}`);
  console.log(
    `  first attempt 200 ${g.filter((r) => r.attempts?.[0]?.status === 200).length}/${g.length}`,
  );
  console.log(
    `  non-200 ${tally(g.flatMap((r) => (r.attempts ?? []).filter((a) => a.status !== 200).map((a) => `${a.status} ${a.error_code ?? ''}`)))}`,
  );
  console.log(`  frame_minus_event_ms ${spread(ok.map((a) => a.frame_minus_event_ms ?? 0))}`);
  const fu = g.flatMap((r) => (r.follow_ups ?? []).map((f) => ({ ...f, r })));
  if (!fu.length) continue;
  for (const o of [...new Set(fu.map((f) => f.offset_ms))]) {
    const at = fu.filter((f) => f.offset_ms === o);
    const good = at.filter((f) => f.status === 200);
    const early = good.filter((f) => (f.frame_minus_requested_ms ?? 0) < 0);
    console.log(
      `  follow-up +${o / 1000} s: ${good.length}/${at.length} 200, requested at event +${spread(at.map((f) => f.requested_ts - f.r.event_ts))}; ` +
        `frame earlier than requested ${early.length} (by ${spread(early.map((f) => -(f.frame_minus_requested_ms ?? 0)))} ms)`,
    );
  }
}
