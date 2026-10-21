// Two independent image judgements run concurrently on the SAME frame. This removes
// sequential model latency without skipping critique or borrowing it from older pixels.
import { imageBlock, parseModelJson, type ContentBlock } from './bedrock.ts';
import { perceptionPrompt, validatePerception, personEvidence } from './perception.ts';
import { validateCritique, VERDICTS } from './critique.ts';
import { decide, inWindow } from './decide.ts';
import type { PipelineConfig } from './pipeline.ts';
export async function judgeFreshFrame(
  jpeg: Buffer,
  captureTs: number,
  evidenceId: string,
  zone: string,
  cfg: Pick<PipelineConfig, 'timezone' | 'nightWindow' | 'context'>,
  converse: (content: ContentBlock[]) => Promise<string>,
) {
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
  const timed = async (content: ContentBlock[]) => {
    const start = Date.now();
    return { text: await converse(content), ms: Date.now() - start };
  };
  const [pResult, cResult] = await Promise.all([
    timed([imageBlock(jpeg), { text: perceptionPrompt(evidenceId) }]),
    timed([imageBlock(jpeg), { text: critique }]),
  ]);
  const perception = parseModelJson(pResult.text),
    crit = parseModelJson(cResult.text);
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
  return { decision, perception, critique: crit, perceptionMs: pResult.ms, critiqueMs: cResult.ms };
}
