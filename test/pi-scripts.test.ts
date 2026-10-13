// The Pi audio scripts, run locally with wpctl/systemd-run/systemctl replaced by shims that
// record their arguments. Covers the stop-epoch ordering; real playback is a hardware gate.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = new URL('../scripts/pi/', import.meta.url).pathname;

let home: string;
let calls: string;

function shim(bin: string, name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(script: string, ...args: string[]): string {
  try {
    return execFileSync(join(SCRIPTS, script), args, {
      env: {
        PATH: `${join(home, 'bin')}:/usr/bin:/bin`,
        HOME: home,
        XDG_STATE_HOME: join(home, 'state'),
        QP_CLIP_DIR: join(home, 'clips'),
      },
    })
      .toString()
      .trim();
  } catch (e) {
    return (e as { stdout: Buffer }).stdout.toString().trim();
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qp-pi-'));
  calls = join(home, 'calls.log');
  writeFileSync(calls, '');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, 'clips'));
  writeFileSync(join(home, 'clips', 'bark-5s.wav'), 'RIFF');
  shim(bin, 'wpctl', '[[ $1 == get-volume ]] && echo "Volume: 0.90"; true');
  shim(bin, 'systemd-run', 'true');
  shim(bin, 'systemctl', 'true'); // list-units prints nothing: no active unit
});

describe('qp-play / qp-stop', () => {
  it('play starts a capped transient unit with RuntimeMaxSec and clamps the volume', () => {
    expect(run('qp-play', 'abc-1', '1791400000000', 'bark-5s')).toBe('started qp-audio-abc-1');
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.60');
    expect(log).toMatch(
      /systemd-run --user --collect --unit=qp-audio-abc-1 -p RuntimeMaxSec=8 pw-play .*bark-5s\.wav/,
    );
  });

  it('stop first, then a launch dispatched before the stop is refused', () => {
    expect(run('qp-stop', '1791400000500')).toBe('stopped');
    expect(run('qp-play', 'abc-2', '1791400000400', 'bark-5s')).toBe('refused_stop_epoch');
    expect(run('qp-play', 'abc-3', '1791400000500', 'bark-5s')).toBe('refused_stop_epoch');
    expect(readFileSync(calls, 'utf8')).not.toContain('systemd-run');
    expect(run('qp-play', 'abc-4', '1791400000600', 'bark-5s')).toBe('started qp-audio-abc-4');
  });

  it('an older stop epoch never lowers the recorded one', () => {
    run('qp-stop', '1791400000900');
    run('qp-stop', '1791400000100');
    expect(
      readFileSync(join(home, 'state', 'quiet-porch', 'audio-stop-epoch'), 'utf8').trim(),
    ).toBe('1791400000900');
  });

  it('arguments outside their patterns and unknown clips are refused before anything runs', () => {
    expect(run('qp-play', 'a;b', '1791400000000', 'bark-5s')).toBe('bad_intent');
    expect(run('qp-play', 'abc', '1791400000000', '../etc')).toBe('bad_clip');
    expect(run('qp-play', 'abc', '1791400000000', 'missing')).toBe('no_clip');
    expect(readFileSync(calls, 'utf8')).toBe('');
  });
});

describe('qp-speak and the volume ceiling', () => {
  const clip = 'speech-' + 'a'.repeat(64);
  beforeEach(() => writeFileSync(join(home, 'clips', `${clip}.wav`), 'RIFF'));
  function runWith(env: Record<string, string>, script: string, ...args: string[]): string {
    try {
      return execFileSync(join(SCRIPTS, script), args, {
        env: {
          PATH: `${join(home, 'bin')}:/usr/bin:/bin`,
          HOME: home,
          XDG_STATE_HOME: join(home, 'state'),
          QP_CLIP_DIR: join(home, 'clips'),
          ...env,
        },
      })
        .toString()
        .trim();
    } catch (e) {
      return (e as { stdout: Buffer }).stdout.toString().trim();
    }
  }
  it('speak starts a 4 s capped unit and clamps volume to 0.60', () => {
    expect(run('qp-speak', 'sp-1', '1791400000000', clip)).toBe('started qp-audio-sp-1');
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.60');
    expect(log).toMatch(/--unit=qp-audio-sp-1 -p RuntimeMaxSec=4 pw-play .*speech-a+\.wav/);
  });
  it.each(['qp-play', 'qp-speak'])(
    '%s ignores an override above 0.60 or a non-number',
    (script) => {
      const c = script === 'qp-play' ? 'bark-5s' : clip;
      for (const cap of ['1.0', 'loud', '0']) {
        writeFileSync(calls, '');
        expect(
          runWith({ QP_VOLUME_CAP: cap }, script, `v-${cap.length}`, '1791400000000', c),
        ).toMatch(/^started/);
        expect(readFileSync(calls, 'utf8')).toContain('set-volume @DEFAULT_AUDIO_SINK@ 0.60');
      }
    },
  );
  it('an override below 0.60 lowers the ceiling', () => {
    runWith({ QP_VOLUME_CAP: '0.40' }, 'qp-speak', 'v-low', '1791400000000', clip);
    expect(readFileSync(calls, 'utf8')).toContain('set-volume @DEFAULT_AUDIO_SINK@ 0.40');
  });
  it('a speak dispatched before a stop is refused and nothing launches', () => {
    expect(run('qp-stop', '1791400000500')).toBe('stopped');
    expect(run('qp-speak', 'sp-2', '1791400000400', clip)).toBe('refused_stop_epoch');
    expect(readFileSync(calls, 'utf8')).not.toContain('systemd-run');
  });
  it('speak refuses a clip name outside the speech-<sha256> pattern', () => {
    expect(run('qp-speak', 'sp-3', '1791400000000', 'bark-5s')).toBe('bad_clip');
  });
});
