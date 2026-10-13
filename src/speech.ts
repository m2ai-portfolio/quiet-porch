import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { approvedSpeech } from './voice.ts';

export type Synthesize = (text: string) => Promise<Buffer>;
// Disabled in the normal server. Construct only for a separately authorized AWS operation.
export function pollySynthesizer(region = 'us-east-1', voiceId = 'Ruth'): Synthesize {
  const client = new PollyClient({ region });
  return async (text) => {
    if (!approvedSpeech(text, text.endsWith(' The owner has been notified.')))
      throw new Error('speech_rejected');
    const result = await client.send(
      new SynthesizeSpeechCommand({
        Text: text,
        TextType: 'text',
        VoiceId: voiceId as 'Ruth',
        Engine: 'generative',
        OutputFormat: 'pcm',
        SampleRate: '16000',
      }),
      { abortSignal: AbortSignal.timeout(1800) },
    );
    if (!result.AudioStream) throw new Error('polly_no_audio');
    return Buffer.from(await result.AudioStream.transformToByteArray());
  };
}
export function pcmWav(pcm: Buffer): Buffer {
  // At most four seconds of 16-kHz mono 16-bit audio; never truncate spoken words.
  if (!pcm.length || pcm.length % 2 || pcm.length > 128000)
    throw new Error('speech_duration_invalid');
  const h = Buffer.alloc(44);
  h.write('RIFF');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function createSpeechOutput(opts: {
  cacheDir: string;
  synthesize: Synthesize;
  play: (path: string, id: string, epoch: number) => Promise<void>;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  async function cached(text: string, refresh: boolean): Promise<string> {
    const path = join(
      opts.cacheDir,
      'speech-' + createHash('sha256').update(text).digest('hex') + '.wav',
    );
    try {
      const file = await readFile(path);
      if (
        file.length > 44 &&
        file.length <= 128044 &&
        file.subarray(0, 4).toString() === 'RIFF' &&
        file.subarray(8, 12).toString() === 'WAVE' &&
        file.readUInt32LE(24) === 16000 &&
        file.readUInt16LE(22) === 1 &&
        file.readUInt16LE(34) === 16 &&
        file.readUInt32LE(40) === file.length - 44
      )
        return path;
    } catch {
      /* uncached */
    }
    if (!refresh) throw new Error('cached_fallback_unavailable');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pcm = await Promise.race([
      opts.synthesize(text),
      new Promise<Buffer>((_, reject) => {
        timer = setTimeout(() => reject(new Error('polly_timeout')), 1800);
      }),
    ]).finally(() => clearTimeout(timer));
    const wav = pcmWav(pcm);
    await mkdir(opts.cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(path, wav, { mode: 0o600 });
    return path;
  }
  return {
    // Prewarm both truthful fallback variants during a separately authorized setup.
    async prepareFallbacks() {
      for (const text of ["You're on camera.", "You're on camera. The owner has been notified."])
        await cached(text, true);
    },
    async speak(text: string, ownerNotified: boolean, id: string, epoch: number) {
      if (!approvedSpeech(text, ownerNotified))
        return { ok: false as const, error: 'speech_rejected' };
      const began = now();
      let fallback = false;
      let actual = text;
      let path: string;
      try {
        path = await cached(text, true);
      } catch {
        fallback = true;
        actual = ownerNotified
          ? "You're on camera. The owner has been notified."
          : "You're on camera.";
        try {
          path = await cached(actual, false);
        } catch {
          return { ok: false as const, error: 'cached_fallback_unavailable' };
        }
      }
      // Check again after synthesis: never play an expired intent after a slow provider response.
      if (now() - epoch >= 3000 || !approvedSpeech(actual, ownerNotified))
        return { ok: false as const, error: 'speech_expired' };
      try {
        await opts.play(path, id, epoch);
      } catch {
        return { ok: false as const, error: 'speech_playback_failed' };
      }
      return { ok: true as const, spokenText: actual, fallback, latencyMs: now() - began };
    },
  };
}
