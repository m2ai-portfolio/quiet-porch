// Bounded recorded-image follow-ups. Authenticated Ring capture metadata, never arrival time.
// The caller starts this only after a newly ingested eligible event from the approved camera.
import { judgeFreshFrame, StaleResultBreak } from './fresh-judgement.ts';
import { createHash } from 'node:crypto';
import { checkEventFrame, type Download } from './frames.ts';
import { evidenceIdFor, judgeFrame, type PipelineConfig } from './pipeline.ts';
import { personEvidence, validatePerception } from './perception.ts';
import { judgementReasons } from './judgement-reasons.ts';
import type { TestEvidence, TestScope } from './attended-test.ts';
import {
  diagnostic,
  safeError,
  safeHttpStatus,
  safeRequestId,
  type DiagnosticConverse,
} from './monitor-diagnostics.ts';
export function createAttendedObserver(deps: {
  parallelCritique?: boolean;
  // Settle both judgements before reporting a failure, typing a provider 503 as
  // ModelUnavailableBreak. Off by default: ongoing monitoring keeps Promise.all.
  settleModelFailures?: boolean;
  // Asked only when a completed result is too old (age >= 6 s). True raises StaleResultBreak
  // after the usual rejection row; absent or false keeps the silent drop.
  breakOnStaleResult?: () => boolean;
  // Adds sanitized perception and critique reasons to judged-frame rows (observation and
  // stale rejection). Off by default: ongoing monitoring rows are unchanged.
  recordJudgementReasons?: boolean;
  scope: TestScope;
  config: () => PipelineConfig;
  download: Download;
  converse: DiagnosticConverse;
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
      const poll = attempts;
      const pollStarted = lastPoll;
      let stage = 'configuration',
        captureTs: number | undefined;
      const record = (row: Record<string, unknown>) =>
        diagnostic(deps.audit, {
          poll,
          poll_started_at: pollStarted,
          requested_ts: requested,
          ...row,
        });
      record({ event: 'observation_started', stage });
      try {
        const cfg = deps.config();
        stage = 'authorization';
        if (!deps.allowed() || cfg.zones[deps.scope.deviceId] !== deps.scope.zone) return;
        stage = 'frame_request';
        const requestedAt = now();
        record({ event: 'frame_requested', stage, requested_at: requestedAt });
        const image = await deps.download(deps.scope.accountId, deps.scope.deviceId, requested, {
          keepImage: true,
        });
        const readyAt = now();
        captureTs =
          typeof image.media_timestamp === 'number' && Number.isFinite(image.media_timestamp)
            ? image.media_timestamp
            : undefined;
        record({
          event: 'frame_completed',
          stage,
          requested_at: requestedAt,
          completed_at: readyAt,
          duration_ms: readyAt - requestedAt,
          capture_ts: captureTs,
          age_at_completion_ms: captureTs === undefined ? undefined : readyAt - captureTs,
          http_status: safeHttpStatus(image.status),
          request_id: safeRequestId(image.request_id),
          media_request_id: safeRequestId(image.media_request_id),
        });
        stage = 'frame_authorization';
        if (!deps.allowed()) return;
        if (image.status === 401 || image.status === 403) {
          blocked = true;
          throw new Error('camera_access_denied');
        }
        stage = 'frame_validation';
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
        stage = 'evidence_key';
        const evidenceId = evidenceIdFor(
          deps.scope.zone,
          deps.scope.deviceId,
          ts,
          // No image storage. The normal evidence key includes its bytes' hash.
          createHash('sha256').update(image.image).digest('hex'),
        );
        stage = 'model_judgement';
        const args = [image.image, ts, evidenceId, deps.scope.zone, cfg, deps.converse] as const;
        const judgement = await (deps.parallelCritique
          ? judgeFreshFrame(
              ...args,
              { audit: record, now },
              { settleSiblings: deps.settleModelFailures === true },
            )
          : judgeFrame(...args));
        stage = 'result_authorization';
        if (!deps.allowed()) return;
        const reasons = deps.recordJudgementReasons === true ? judgementReasons(judgement) : {};
        const age = now() - ts;
        if (age < 0 || age >= 6000) {
          deps.audit({ event: 'followup_rejected', reason: 'model_result_stale', ...reasons });
          // A reversed clock (age < 0) is never "too old" and never recoverable.
          if (age >= 6000 && deps.breakOnStaleResult?.() === true) {
            stage = 'result_freshness';
            throw new StaleResultBreak(ts);
          }
          return;
        }
        stage = 'result_validation';
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
        stage = 'observation_audit';
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
          ...reasons,
        });
        return { ...deps.scope, id: evidenceId, captureTs: ts, source: 'ring', verdict };
      } catch (error) {
        const end = now();
        record({
          event: 'observation_failed',
          stage,
          completed_at: end,
          duration_ms: end - pollStarted,
          capture_ts: captureTs,
          age_at_completion_ms: captureTs === undefined ? undefined : end - captureTs,
          ...safeError(error),
        });
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
