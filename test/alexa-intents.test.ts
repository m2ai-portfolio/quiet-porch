import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The stand-in page keeps its phrase table inline. Pull it out and run the real table, so the
// routing of safety phrases is tested against the page as shipped.
const html = readFileSync(new URL('../src/alexa-sim.html', import.meta.url), 'utf8');
const start = html.indexOf('const intents = [');
const end = html.indexOf('let id = 0');
const intents = new Function(`${html.slice(start, end)}; return intents;`)() as [
  RegExp,
  () => [string, object],
][];
const route = (q: string) => intents.find(([re]) => re.test(q))?.[1]()[0] ?? 'none';

describe('/alexa phrase routing', () => {
  it('safety phrases still reach their tools even when they also ask whether this is live', () => {
    expect(route('stop, is this real?')).toBe('stand_down');
    expect(route('stand down, are you live')).toBe('stand_down');
    expect(route("I'm stepping out, is it real")).toBe('expect_me');
    expect(route("I'm leaving, is it live")).toBe('set_mode');
    expect(route('what happened last night')).toBe('get_night_report');
  });

  it('"is this live" gets the (labelled) status, and "real" is matched as a whole word', () => {
    expect(route('is this live')).toBe('get_incident_status');
    expect(route('are we live')).toBe('get_incident_status');
    expect(route('is it real')).toBe('get_incident_status');
    expect(route('is it real quiet outside')).not.toBe('get_incident_status');
    expect(route('is this realistic')).not.toBe('get_incident_status');
  });
});
