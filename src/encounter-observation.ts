import type { createAttendedTest, TestEvidence } from './attended-test.ts';
import { diagnostic, type DiagnosticAudit } from './monitor-diagnostics.ts';

export function routineEncounterEnd(reason: string | undefined): boolean {
  return [
    'evidence_lost',
    'session_expired',
    'departure',
    'uncertain',
    'capture_gap',
    'action_evidence_expired',
    'night_window_ended',
  ].includes(reason ?? '');
}

// Capture the encounter, not monitor.current(): the watchdog can collect it while
// an asynchronous camera/model request is still unwinding.
export async function pollEncounterObservation(
  encounter: ReturnType<typeof createAttendedTest>,
  poll: () => Promise<TestEvidence | undefined>,
  audit: DiagnosticAudit,
): Promise<TestEvidence | undefined> {
  let frame: TestEvidence | undefined;
  try {
    frame = await poll();
  } catch (error) {
    // Identity matters: an independent provider timeout/AbortError remains fatal,
    // even if it races with a watchdog. Only our own cancellation is expected.
    if (
      !encounter.signal.aborted ||
      encounter.status().state !== 'ended' ||
      error !== encounter.signal.reason
    )
      throw error;
  }
  if (!encounter.signal.aborted) return frame;
  // disarm is idempotent and joins existing cleanup; it cannot re-arm anything.
  await encounter.disarm();
  if (encounter.status().cleanupSucceeded !== true) throw new Error('encounter_cleanup_failed');
  diagnostic(audit, {
    event: 'encounter_observation_cancelled',
    stage: 'observe',
    routine_end: routineEncounterEnd(encounter.status().endReason),
    cleanup_succeeded: true,
  });
  return undefined; // Never feed a late result into this or a subsequent encounter.
}
