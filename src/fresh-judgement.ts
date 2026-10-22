// Two independent image judgements run concurrently on the SAME frame. This removes
// sequential model latency without skipping critique or borrowing it from older pixels.
import { BedrockHttpError, imageBlock, parseModelJson, type ContentBlock } from './bedrock.ts';
import { perceptionPrompt, validatePerception, personEvidence } from './perception.ts';
import { validateCritique, VERDICTS } from './critique.ts';
import { decide, inWindow } from './decide.ts';
import type { PipelineConfig } from './pipeline.ts';
import {
  diagnostic,
  safeError,
  safeHttpStatus,
  safeRequestId,
  safeUsage,
  type DiagnosticAudit,
  type DiagnosticConverse,
} from './monitor-diagnostics.ts';

// Only a typed provider 503 qualifies. Timeouts, parse failures, other statuses and
// untyped errors with a similar message are never recoverable.
export function isModelUnavailable(error: unknown): boolean {
  return error instanceof BedrockHttpError && error.status === 503;
}

// Raised only after BOTH judgements of the failed frame have settled, so a caller that
// discards the frame leaves no request of that observation running.
export class ModelUnavailableBreak extends Error {
  readonly reason = 'model_unavailable_503';
  readonly captureTs: number;
  constructor(captureTs: number) {
    super('model_unavailable_503');
    this.captureTs = captureTs;
  }
}

// A judgement that completed but whose result was already too old to be evidence. Raised
// only when the runner says the one recovery is still available inside a started encounter;
// otherwise the result is dropped silently, exactly as without recovery. Never a fault.
export class StaleResultBreak extends Error {
  readonly reason = 'model_result_stale';
  readonly captureTs: number;
  constructor(captureTs: number) {
    super('model_result_stale');
    this.captureTs = captureTs;
  }
}

export type RecoveryCause = ModelUnavailableBreak['reason'] | StaleResultBreak['reason'];

export async function judgeFreshFrame(
  jpeg: Buffer,
  captureTs: number,
  evidenceId: string,
  zone: string,
  cfg: Pick<PipelineConfig, 'timezone' | 'nightWindow' | 'context'>,
  converse: DiagnosticConverse,
  diagnostics?: { audit: DiagnosticAudit; now?: () => number },
  options?: { settleSiblings?: boolean },
) {
  const now = diagnostics?.now ?? Date.now;
  const record = (row: Record<string, unknown>) => {
    if (diagnostics) diagnostic(diagnostics.audit, row);
  };
  const context = cfg.context;
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(captureTs));
  const critique = [
    'You are an independent visual critique of ONE yard camera frame against household context. You do not choose actions.',
    'Do not guess identity, threat or dwell from clothing, infrared lighting, or a single still frame. Dwell is measured separately.',
    `Zone: ${zone}. Local time: ${localTime}. Mode: ${context.mode}.`,
    ...(context.testSetting === 'office'
      ? [
          'Supervised office test: this camera is temporarily indoors, so the frame shows a room, not the configured zone. The zone above is its configured name, not its current location.',
          'Being indoors, the absence of a yard scene, or a mismatch with the zone name is never a reason for uncertain. Apply the verdict rules below to the people and animals visible in this frame exactly as you would in the configured zone. Use uncertain only when you cannot tell what is visible or what it is doing.',
        ]
      : []),
    `Known pets: ${context.knownPets.join('; ') || 'none'}.`,
    `Expected visitors/deliveries: ${context.expectedVisitors.join('; ') || 'none'}.`,
    `Routines: ${context.routines.join('; ') || 'none'}.`,
    `Nuisance species: ${context.nuisanceSpecies.join(', ') || 'none'}.`,
    'Verdicts: benign for an expected visitor/delivery/routine/known pet or nothing of note; unknown for an unidentified person not matched to context; suspicious only for directly visible concerning behavior; nuisance only for configured species; uncertain when unsure.',
    `Return ONLY JSON: {"evidence_id":"${evidenceId}","person_present":boolean,"verdict":one of ${VERDICTS.join('|')},"reasons":[short strings]}`,
  ].join('\n');
  const timed = async (
    model: 'perception' | 'critique',
    content: ContentBlock[],
    signal?: AbortSignal,
  ) => {
    const start = now();
    let metadata: {
      http_status?: number;
      request_id?: string;
      input_tokens?: number;
      output_tokens?: number;
      stop_reason?: string;
    } = {};
    record({
      event: 'model_started',
      stage: 'model_request',
      model,
      started_at: start,
      capture_ts: captureTs,
    });
    try {
      const text = await converse(
        content,
        (response) => {
          metadata = {
            http_status: safeHttpStatus(response.status),
            request_id: safeRequestId(response.requestId),
            ...safeUsage(response.usage),
          };
        },
        signal,
      );
      const end = now();
      record({
        event: 'model_completed',
        stage: 'model_request',
        model,
        started_at: start,
        completed_at: end,
        duration_ms: end - start,
        capture_ts: captureTs,
        age_at_completion_ms: end - captureTs,
        ...metadata,
      });
      return { text, ms: end - start, metadata };
    } catch (error) {
      const end = now();
      record({
        event: 'model_failed',
        stage: 'model_request',
        model,
        started_at: start,
        completed_at: end,
        duration_ms: end - start,
        capture_ts: captureTs,
        age_at_completion_ms: end - captureTs,
        ...metadata,
        ...safeError(error),
      });
      throw error;
    }
  };
  const start = (signal?: AbortSignal) => [
    timed(
      'perception',
      [imageBlock(jpeg), { text: perceptionPrompt(evidenceId, { brief: true }) }],
      signal,
    ),
    timed('critique', [imageBlock(jpeg), { text: critique }], signal),
  ];
  let pResult: Awaited<ReturnType<typeof timed>>, cResult: Awaited<ReturnType<typeof timed>>;
  if (!options?.settleSiblings) [pResult, cResult] = await Promise.all(start());
  else {
    // Promise.all rejects before the sibling settles. Here the first failure aborts the
    // sibling and both outcomes are awaited before anything is reported.
    const local = new AbortController();
    const siblingAbort = new DOMException('sibling_failed', 'AbortError');
    let failed = false,
      first: unknown;
    const settled = await Promise.allSettled(
      start(local.signal).map((request) =>
        request.catch((error: unknown) => {
          if (!failed) {
            failed = true;
            first = error;
            local.abort(siblingAbort);
          }
          throw error;
        }),
      ),
    );
    if (failed) {
      const benign = settled.every(
        (s) =>
          s.status === 'fulfilled' || s.reason === siblingAbort || isModelUnavailable(s.reason),
      );
      if (isModelUnavailable(first) && benign) throw new ModelUnavailableBreak(captureTs);
      throw first;
    }
    [pResult, cResult] = settled.map((s) => (s as PromiseFulfilledResult<typeof pResult>).value);
  }
  const parse = (model: 'perception' | 'critique', result: typeof pResult) => {
    const start = now();
    try {
      return parseModelJson(result.text);
    } catch (error) {
      const end = now();
      record({
        event: 'model_failed',
        stage: 'model_parse',
        model,
        started_at: start,
        completed_at: end,
        duration_ms: end - start,
        capture_ts: captureTs,
        age_at_completion_ms: end - captureTs,
        ...result.metadata,
        ...safeError(error),
        error_category: 'parse',
      });
      throw error;
    }
  };
  const perception = parse('perception', pResult),
    crit = parse('critique', cResult);
  const validationStarted = now();
  try {
    const validated = validatePerception(perception, evidenceId);
    const critic = crit as { person_present?: unknown; verdict?: unknown };
    if (
      !validated.ok ||
      typeof critic.person_present !== 'boolean' ||
      (['unknown', 'suspicious'].includes(String(critic.verdict)) &&
        critic.person_present !== true) ||
      critic.person_present !== personEvidence(validated.value).signal
    ) {
      return {
        decision: { kind: 'reject' as const, reason: 'independent_judgement_disagreement' },
        perception,
        critique: crit,
        perceptionMs: pResult.ms,
        critiqueMs: cResult.ms,
      };
    }
    const decision = decide({
      perception: validatePerception(perception, evidenceId),
      critique: validateCritique(crit, evidenceId),
      nuisanceSpecies: context.nuisanceSpecies,
      mode: context.mode,
      inNightWindow: inWindow(captureTs, cfg.nightWindow.start, cfg.nightWindow.end, cfg.timezone),
    });
    return {
      decision,
      perception,
      critique: crit,
      perceptionMs: pResult.ms,
      critiqueMs: cResult.ms,
    };
  } catch (error) {
    const end = now();
    record({
      event: 'judgement_failed',
      stage: 'model_validation',
      started_at: validationStarted,
      completed_at: end,
      duration_ms: end - validationStarted,
      capture_ts: captureTs,
      age_at_completion_ms: end - captureTs,
      perception_request_id: pResult.metadata.request_id,
      critique_request_id: cResult.metadata.request_id,
      ...safeError(error),
    });
    throw error;
  }
}
