// Bounded recorded-image follow-ups. Authenticated Ring capture metadata, never arrival time.
// The caller starts this only after a newly ingested eligible event from the approved camera.
import { judgeFreshFrame } from './fresh-judgement.ts';
import { createHash } from 'node:crypto';
import { checkEventFrame, type Download } from './frames.ts';
import { evidenceIdFor, judgeFrame, type PipelineConfig } from './pipeline.ts';
import { personEvidence, validatePerception } from './perception.ts';
import type { ContentBlock } from './bedrock.ts';
import type { TestEvidence, TestScope } from './attended-test.ts';
export function createAttendedObserver(deps: {
  parallelCritique?: boolean;
  scope: TestScope;
  config: () => PipelineConfig;
  download: Download;
  converse: (content: ContentBlock[]) => Promise<string>;
  allowed: () => boolean;
  audit: (r: Record<string, unknown>) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let blocked = false,
    busy = false,
    attempts = 0,
    lastPoll = -Infinity,
    lastCapture = -Infinity;
  return {
    async poll(): Promise<TestEvidence | undefined> {
      if (blocked || busy || !deps.allowed() || attempts >= 30 || now() - lastPoll < 2000) return;
      busy = true;
      attempts++;
      lastPoll = now();
      const requested = lastPoll - 2000;
      try {
        const cfg = deps.config();
        if (!deps.allowed() || cfg.zones[deps.scope.deviceId] !== deps.scope.zone) return;
        const image = await deps.download(deps.scope.accountId, deps.scope.deviceId, requested, {
          keepImage: true,
        });
        if (!deps.allowed()) return;
        if (image.status === 401 || image.status === 403) {
          blocked = true;
          throw new Error('camera_access_denied');
        }
        const check = checkEventFrame(image, requested, lastPoll);
        const ts = image.media_timestamp;
        if (
          !check.ok ||
          !image.image ||
          ts === undefined ||
          now() - ts >= 6000 ||
          ts <= lastCapture
        ) {
          deps.audit({
            event: 'followup_rejected',
            reason: check.ok ? 'missing_stale_or_repeated' : check.reason,
          });
          return;
        }
        lastCapture = ts;
        const evidenceId = evidenceIdFor(
          deps.scope.zone,
          deps.scope.deviceId,
          ts,
          // No image storage. The normal evidence key includes its bytes' hash.
          createHash('sha256').update(image.image).digest('hex'),
        );
        const judgement = await (deps.parallelCritique ? judgeFreshFrame : judgeFrame)(
          image.image,
          ts,
          evidenceId,
          deps.scope.zone,
          cfg,
          deps.converse,
        );
        if (!deps.allowed()) return;
        const age = now() - ts;
        if (age < 0 || age >= 6000) {
          deps.audit({ event: 'followup_rejected', reason: 'model_result_stale' });
          return;
        }
        const p = validatePerception(judgement.perception, evidenceId);
        let verdict: TestEvidence['verdict'] = 'uncertain';
        if (p.ok) {
          const person = personEvidence(p.value);
          if (
            !person.signal &&
            !person.contradiction &&
            judgement.decision.kind === 'log' &&
            judgement.decision.reason === 'nothing_actionable'
          )
            verdict = 'empty';
          if (judgement.decision.kind === 'intruder' && person.detected && !person.contradiction)
            verdict = 'person';
        }
        deps.audit({
          event: 'followup_observation',
          perception_ms: judgement.perceptionMs,
          critique_ms: judgement.critiqueMs,
          age_at_completion_ms: age,
          parallel_critique: deps.parallelCritique === true,
          evidence_id: evidenceId,
          capture_ts: ts,
          verdict,
          decision: judgement.decision.kind,
          reason: judgement.decision.reason,
        });
        return { ...deps.scope, id: evidenceId, captureTs: ts, source: 'ring', verdict };
      } finally {
        busy = false;
      }
    },
  };
}
