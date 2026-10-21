// Observation-only entry point. No output adapters, subprocesses or live flag.
import { runBoundedYard, boundedYardLimits, type YardRunDependencies } from './bounded-yard.ts';
export const qualificationLimits = boundedYardLimits;
export async function runYardQualification(deps: YardRunDependencies) {
  const result = await runBoundedYard(deps, { mode: 'output_disabled' });
  return {
    ...result,
    would_alert: result.alert_attempts,
    would_speak: result.speech_attempts,
  };
}
