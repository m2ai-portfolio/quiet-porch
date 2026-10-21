// Matt approved 100% for this Anker on 2026-10-21. Other speakers retain the 60% limit.
const fullVolumeSpeakerFingerprint = '12b20969fc2c';

export function speakerVolumeAllowed(volume: number, speakerFingerprint: string): boolean {
  const ceiling = speakerFingerprint === fullVolumeSpeakerFingerprint ? 1 : 0.6;
  return Number.isFinite(volume) && volume > 0 && volume <= ceiling;
}

// The yard monitor must not silently pass readiness after the owner's level drifts.
// This validates the readback only; it never changes a device's volume.
export function speakerVolumeReady(volume: number, speakerFingerprint: string): boolean {
  return (
    speakerVolumeAllowed(volume, speakerFingerprint) &&
    (speakerFingerprint !== fullVolumeSpeakerFingerprint || volume === 1)
  );
}
