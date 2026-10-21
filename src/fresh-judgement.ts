// Two independent image judgements run concurrently on the SAME frame. This removes
// sequential model latency without skipping critique or borrowing it from older pixels.
import { imageBlock, parseModelJson, type ContentBlock } from './bedrock.ts';
import { perceptionPrompt, validatePerception, personEvidence } from './perception.ts';
import { validateCritique, VERDICTS } from './critique.ts';
import { decide, inWindow } from './decide.ts';
import type { PipelineConfig } from './pipeline.ts';
import {
  diagnostic,
  safeError,
  safeHttpStatus,
  safeRequestId,
  type DiagnosticAudit,
  type DiagnosticConverse,
} from './monitor-diagnostics.ts';
export async function judgeFreshFrame(
  jpeg: Buffer,
  captureTs: number,
  evidenceId: string,
  zone: string,
  cfg: Pick<PipelineConfig, 'timezone' | 'nightWindow' | 'context'>,
  converse: DiagnosticConverse,
  diagnostics?: { audit: DiagnosticAudit; now?: () => number },
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
    `Known pets: ${context.knownPets.join('; ') || 'none'}.`,
    `Expected visitors/deliveries: ${context.expectedVisitors.join('; ') || 'none'}.`,
    `Routines: ${context.routines.join('; ') || 'none'}.`,
    `Nuisance species: ${context.nuisanceSpecies.join(', ') || 'none'}.`,
    'Verdicts: benign for an expected visitor/delivery/routine/known pet or nothing of note; unknown for an unidentified person not matched to context; suspicious only for directly visible concerning behavior; nuisance only for configured species; uncertain when unsure.',
    `Return ONLY JSON: {"evidence_id":"${evidenceId}","person_present":boolean,"verdict":one of ${VERDICTS.join('|')},"reasons":[short strings]}`,
  ].join('\n');
  const timed = async (model: 'perception' | 'critique', content: ContentBlock[]) => {
    const start = now();
    let metadata: { http_status?: number; request_id?: string } = {};
    record({
      event: 'model_started',
      stage: 'model_request',
      model,
      started_at: start,
      capture_ts: captureTs,
    });
    try {
      const text = await converse(content, (response) => {
        metadata = {
          http_status: safeHttpStatus(response.status),
          request_id: safeRequestId(response.requestId),
        };
      });
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
  const [pResult, cResult] = await Promise.all([
    timed('perception', [imageBlock(jpeg), { text: perceptionPrompt(evidenceId) }]),
    timed('critique', [imageBlock(jpeg), { text: critique }]),
  ]);
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
