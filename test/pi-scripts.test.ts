// The Pi audio scripts, run locally with wpctl/systemd-run/systemctl replaced by shims that
// record their arguments. Covers the stop-epoch ordering; real playback is a hardware gate.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = new URL('../scripts/pi/', import.meta.url).pathname;

// Audio playback/Stop scripts require flock; macOS does not ship it. Guard only those
// suites. qp-speaker-setup does not call flock and must still run on supported hosts.
const hasFlock = ['/usr/bin', '/bin'].some((dir) => existsSync(join(dir, 'flock')));

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

describe.skipIf(!hasFlock)('qp-play / qp-stop', () => {
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

describe.skipIf(!hasFlock)('qp-speak and the volume ceiling', () => {
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
  it.each(['qp-play', 'qp-speak'])(
    '%s leaves the approved Anker at 100% and pins playback to that verified output',
    (script) => {
      const bin = join(home, 'bin');
      // Synthetic device and hash shim keep the private speaker address out of fixtures.
      shim(
        bin,
        'wpctl',
        `
if [[ $1 == inspect ]]; then
  echo 'id 42, type PipeWire:Interface:Node'
  echo '  node.name = "bluez_output.AA:BB:CC:DD:EE:0F"'
fi
[[ $1 == get-volume ]] && echo 'Volume: 1.00'
true`,
      );
      shim(
        bin,
        'sha256sum',
        "cat >/dev/null; echo '12b20969fc2c00000000000000000000000000000000000000000000000000000000  -'",
      );
      const c = script === 'qp-play' ? 'bark-5s' : clip;
      expect(runWith({ QP_VOLUME_CAP: '0.60' }, script, 'approved-1', '1791400000000', c)).toBe(
        'started qp-audio-approved-1',
      );
      const log = readFileSync(calls, 'utf8');
      expect(log).toContain('wpctl get-volume 42');
      expect(log).not.toContain('wpctl set-volume');
      expect(log).toContain('pw-play --target=bluez_output.AA:BB:CC:DD:EE:0F');
      expect(log).toContain(`RuntimeMaxSec=${script === 'qp-play' ? 8 : 4}`);
    },
  );
  it.each(['qp-play', 'qp-speak'])(
    '%s retains 60% for an unapproved Bluetooth output even when 100% is requested',
    (script) => {
      shim(
        join(home, 'bin'),
        'wpctl',
        `
if [[ $1 == inspect ]]; then
  echo 'id 42, type PipeWire:Interface:Node'
  echo '  node.name = "bluez_output.AA:BB:CC:DD:EE:0F"'
fi
[[ $1 == get-volume ]] && echo 'Volume: 1.00'
true`,
      );
      const c = script === 'qp-play' ? 'bark-5s' : clip;
      expect(runWith({ QP_VOLUME_CAP: '1.00' }, script, 'other-1', '1791400000000', c)).toBe(
        'started qp-audio-other-1',
      );
      expect(readFileSync(calls, 'utf8')).toContain('wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.60');
    },
  );
  it('a speak dispatched before a stop is refused and nothing launches', () => {
    expect(run('qp-stop', '1791400000500')).toBe('stopped');
    expect(run('qp-speak', 'sp-2', '1791400000400', clip)).toBe('refused_stop_epoch');
    expect(readFileSync(calls, 'utf8')).not.toContain('systemd-run');
  });
  it('speak refuses a clip name outside the speech-<sha256> pattern', () => {
    expect(run('qp-speak', 'sp-3', '1791400000000', 'bark-5s')).toBe('bad_clip');
  });
});

describe('qp-speaker-setup', () => {
  // A made-up address: the real speaker's stays out of the public repo.
  const MAC = 'AA:BB:CC:DD:EE:0F';
  const cfg = () => join(home, '.config');
  it('renders both files for one speaker, writes a seamless -40 dBFS tone and enables the unit', () => {
    expect(run('qp-speaker-setup', MAC)).toBe('installed');
    const conf = readFileSync(
      join(cfg(), 'wireplumber/wireplumber.conf.d/51-quiet-porch-anker-nosuspend.conf'),
      'utf8',
    );
    expect(conf).toContain('device.name = "bluez_card.AA_BB_CC_DD_EE_0F"');
    expect(conf).toContain('node.name = "bluez_output.AA_BB_CC_DD_EE_0F.1"');
    expect(conf).toContain('session.suspend-timeout-seconds = 0, node.pause-on-idle = false');
    const unit = readFileSync(join(cfg(), 'systemd/user/qp-keepalive.service'), 'utf8');
    expect(unit).toContain('pw-play --target=bluez_output.AA:BB:CC:DD:EE:0F ');
    expect(conf + unit).not.toContain('@');
    // qp-stop stops qp-audio-* only, so Stop can never silence the keep-alive.
    expect(readFileSync(join(SCRIPTS, 'qp-stop'), 'utf8')).toContain("'qp-audio-*'");

    const wav = readFileSync(join(home, 'quiet-porch/keepalive/keepalive-20hz.wav'));
    expect([wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual([
      2, 48000, 16,
    ]);
    const pcm = wav.subarray(44);
    expect(pcm.length).toBe(60 * 48000 * 4);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(20 * Math.log10(peak / 32767)).toBeCloseTo(-40, 1);
    expect(pcm.readInt16LE(0)).toBe(0); // starts and ends a period at zero: no click on loop

    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user restart wireplumber',
      'systemctl --user enable --now qp-keepalive',
    ]);
  });
  it('refuses a malformed address before writing anything', () => {
    for (const bad of ['', 'aa:bb:cc:dd:ee:ff', 'AA:BB:CC:DD:EE', 'AA:BB:CC:DD:EE:FF;rm'])
      expect(run('qp-speaker-setup', bad)).toBe('bad_mac');
    expect(readFileSync(calls, 'utf8')).toBe('');
    expect(() => readFileSync(join(cfg(), 'systemd/user/qp-keepalive.service'))).toThrow();
  });
});

// The guarded helper reads the Pi's boot id and CLOCK_BOOTTIME, so this suite runs on Linux.
// replay-3 (2026-10-21): readiness passed at the approved office level 0.36, then this helper
// refused the speech because it accepted only 1.00.
describe.skipIf(!existsSync('/proc/sys/kernel/random/boot_id'))(
  'qp-speak-guarded accepts only the approved Anker levels',
  () => {
    const clip = 'speech-' + 'b'.repeat(64);
    const address = 'AA:BB:CC:DD:EE:0F';
    function guarded(volume: string): string {
      const bin = join(home, 'bin');
      writeFileSync(join(home, 'clips', `${clip}.wav`), 'RIFF');
      // Synthetic device: swap the approved fingerprint for the fixture address's hash.
      const helper = join(home, 'qp-speak-guarded');
      const fixture = execFileSync('python3', [
        '-c',
        `import hashlib;print(hashlib.sha256(b"${address}").hexdigest()[:12])`,
      ])
        .toString()
        .trim();
      const source = readFileSync(join(SCRIPTS, 'qp-speak-guarded'), 'utf8');
      expect(source).toContain("APPROVED_SPEAKER = '12b20969fc2c'");
      writeFileSync(
        helper,
        source.replace("APPROVED_SPEAKER = '12b20969fc2c'", `APPROVED_SPEAKER = '${fixture}'`),
      );
      chmodSync(helper, 0o755);
      shim(
        bin,
        'wpctl',
        `
if [[ $1 == inspect ]]; then
  echo 'id 42, type PipeWire:Interface:Node'
  echo '  node.name = "bluez_output.${address.replaceAll(':', '_')}"'
fi
[[ $1 == get-volume ]] && echo '${volume}'
true`,
      );
      // The transient unit runs the helper's own play step, as systemd would.
      shim(
        bin,
        'systemd-run',
        'while [[ $1 != */qp-speak-guarded ]]; do shift; done; "$@" >/dev/null &',
      );
      shim(bin, 'pw-play', 'true');
      const [boot, nowMs] = execFileSync('python3', [
        '-c',
        'import time,pathlib;print(pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(), time.clock_gettime_ns(time.CLOCK_BOOTTIME)//1000000)',
      ])
        .toString()
        .trim()
        .split(' ');
      try {
        return execFileSync(
          helper,
          ['dispatch', 'vol-1', '1791400000000', clip, fixture, boot, String(Number(nowMs) + 4000)],
          {
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              HOME: home,
              XDG_STATE_HOME: join(home, 'state'),
              QP_CLIP_DIR: join(home, 'clips'),
            },
          },
        )
          .toString()
          .trim();
      } catch (e) {
        return (e as { stdout: Buffer }).stdout.toString().trim();
      }
    }
    it.each(['Volume: 1.00', 'Volume: 0.36'])('plays at %s', (volume) => {
      expect(guarded(volume)).toBe('accepted qp-audio-vol-1');
      expect(readFileSync(calls, 'utf8')).toContain(
        'pw-play --target=bluez_output.AA_BB_CC_DD_EE_0F',
      );
    });
    it.each(['Volume: 0.50', 'Volume: 0.37', 'Volume: 0.36 [MUTED]', 'Volume: 0.60'])(
      'refuses %s and launches nothing',
      (volume) => {
        expect(guarded(volume)).toBe('refused_volume');
        expect(readFileSync(calls, 'utf8')).not.toContain('systemd-run');
      },
    );
  },
);
