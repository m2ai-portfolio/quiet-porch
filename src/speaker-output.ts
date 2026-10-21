import { diagnostic, safeError, type DiagnosticAudit } from './monitor-diagnostics.ts';
import { speakerVolumeAllowed } from './speaker-volume.ts';
import type { TestOutputs } from './attended-test.ts';

// One read-only SSH round trip. Only fixed fields leave the Pi; no helper contents,
// device addresses, command stderr or exception messages enter the diagnostic journal.
export function speakerReadinessCommand(clip: string) {
  if (!/^speech-[a-f0-9]{64}$/.test(clip)) throw new Error('invalid_speech_clip');
  const script = `import hashlib,json,re,shutil,subprocess,sys
from pathlib import Path
stage="sink"
try:
 sink=subprocess.check_output(["wpctl","inspect","@DEFAULT_AUDIO_SINK@"],text=True,timeout=1)
 match=re.search(r'node\\.name = "bluez_output\\.([^"\\n]+)"',sink)
 address=match.group(1).replace("_",":").upper() if match else ""
 fingerprint=hashlib.sha256(address.encode()).hexdigest()[:12] if re.fullmatch(r"(?:[A-F0-9]{2}:){5}[A-F0-9]{2}",address) else ""
 stage="volume"
 volume=subprocess.check_output(["wpctl","get-volume","@DEFAULT_AUDIO_SINK@"],text=True,timeout=1).strip()
 match=re.fullmatch(r"Volume: ([0-9.]+)",volume)
 value=float(match.group(1)) if match else None
 stage="helper"
 helper=Path(shutil.which("qp-speak") or "").read_text()
 stage="status"
 status=subprocess.check_output(["qp-status"],text=True,timeout=1).strip()
 stage="clip"
 present=(Path.home()/"quiet-porch"/"clips"/(sys.argv[1]+".wav")).is_file()
 print(json.dumps({"speakerFingerprint":fingerprint,"virtual":bool(re.search(r'auto_null|Dummy Output|node.virtual = "true"',sink)),"volume":value,"idle":status=="idle","boundedHelper":"-p RuntimeMaxSec=4" in helper,"clipPresent":present}))
except Exception as error:
 result={"failedCheck":stage}
 code=getattr(error,"returncode",None)
 if isinstance(code,int) and 0<=code<=255: result["exitCode"]=code
 print(json.dumps(result))`;
  return `python3 -c '${script.replaceAll("'", "'\\''")}' ${clip}`;
}

export function createSpeakerOutput(deps: {
  ssh: (command: string, signal?: AbortSignal) => Promise<string>;
  speakerFingerprint: string;
  clip: string;
  authorized: () => boolean;
  killed: () => boolean;
  audit: DiagnosticAudit;
  now?: () => number;
  mono?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const mono = deps.mono ?? (() => performance.now());
  const command = speakerReadinessCommand(deps.clip);
  const checks = ['sink', 'volume', 'helper', 'status', 'clip'] as const;
  async function ready(signal?: AbortSignal): Promise<boolean> {
    const started = mono();
    diagnostic(deps.audit, { event: 'speaker_readiness_started', started_at: now() });
    try {
      const snapshot: unknown = JSON.parse(await deps.ssh(command, signal));
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
        throw new Error('readiness_protocol');
      const s = snapshot as Record<string, unknown>;
      const failedCheck = checks.find((check) => s.failedCheck === check);
      const reason =
        s.failedCheck !== undefined
          ? (failedCheck ?? 'protocol')
          : s.speakerFingerprint !== deps.speakerFingerprint || s.virtual !== false
            ? 'sink'
            : typeof s.volume !== 'number' ||
                !speakerVolumeAllowed(s.volume, deps.speakerFingerprint)
              ? 'volume'
              : s.boundedHelper !== true
                ? 'helper'
                : s.idle !== true
                  ? 'status'
                  : s.clipPresent !== true
                    ? 'clip'
                    : undefined;
      diagnostic(deps.audit, {
        event: 'speaker_readiness_completed',
        completed_at: now(),
        elapsed_ms: mono() - started,
        ready: reason === undefined,
        ...(reason ? { rejected_check: reason } : {}),
        ...(Number.isInteger(s.exitCode) && Number(s.exitCode) >= 0 && Number(s.exitCode) <= 255
          ? { exit_code: s.exitCode }
          : {}),
      });
      return reason === undefined;
    } catch (error) {
      diagnostic(deps.audit, {
        event: 'speaker_readiness_failed',
        failed_at: now(),
        elapsed_ms: mono() - started,
        ...safeError(error),
      });
      throw error;
    }
  }
  function outputs(): Pick<TestOutputs, 'speak' | 'stop'> {
    let speechMayHaveStarted = false;
    return {
      async speak(id, signal, allowed) {
        const started = mono();
        let stage = 'cancelled';
        try {
          if (signal.aborted) throw new Error('speech_cancelled');
          stage = 'readiness';
          if (!(await ready(signal))) throw new Error('audio_not_ready');
          stage = 'cancelled';
          if (signal.aborted) throw new Error('speech_cancelled');
          stage = 'authority';
          if (!deps.authorized()) throw new Error('audio_not_authorized');
          stage = 'emergency_disarm';
          if (deps.killed()) throw new Error('audio_disarmed');
          diagnostic(deps.audit, {
            event: 'speech_prepared',
            prepared_at: now(),
            elapsed_ms: mono() - started,
          });
          // Final action-time check AFTER all preparation, including diagnostic writes.
          // Never refresh capture timestamps or weaken the controller's six-second guard.
          stage = 'freshness';
          if (!allowed()) throw new Error('action_evidence_expired');
          stage = 'dispatch';
          speechMayHaveStarted = true; // Includes ambiguous SSH outcomes; cleanup must run.
          const response = await deps.ssh(`qp-speak ${id} ${now()} ${deps.clip}`, signal);
          stage = 'acknowledgement';
          if (response !== `started qp-audio-${id}`) throw new Error('playback_not_acknowledged');
          diagnostic(deps.audit, {
            event: 'speech_dispatch_acknowledged',
            acknowledged_at: now(),
            elapsed_ms: mono() - started,
          });
        } catch (error) {
          diagnostic(deps.audit, {
            event: 'speech_output_failed',
            stage,
            failed_at: now(),
            elapsed_ms: mono() - started,
            ...safeError(error),
          });
          throw error;
        }
      },
      async stop() {
        if (!speechMayHaveStarted) return;
        const response = await deps.ssh(`qp-stop ${now() + 1}`);
        if (response !== 'stopped' || (await deps.ssh('qp-status')) !== 'idle')
          throw new Error('cleanup_not_acknowledged');
      },
    };
  }
  return { ready, outputs };
}
