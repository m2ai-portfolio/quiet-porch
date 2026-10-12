import { describe, expect, it, vi } from 'vitest';
import { bannedIn, composeLine, createStubSpeaker, FALLBACK_LINE } from '../src/voice.ts';

describe('the porch speaks: fixed template, filled slots (F2)', () => {
  it('fills place and clothing into the template, and nothing else', () => {
    expect(composeLine({ place: 'side gate', clothing: 'dark jacket' }).text).toBe(
      "You're on camera at the side gate. I can see a dark jacket. The owner has been notified.",
    );
    expect(composeLine({ place: 'the front steps' }).text).toBe(
      "You're on camera at the front steps. The owner has been notified.",
    );
    expect(composeLine({ clothing: 'orange hoodie' }).text).toBe(
      "You're on camera. I can see an orange hoodie. The owner has been notified.",
    );
    expect(composeLine({}).text).toBe("You're on camera. The owner has been notified.");
  });

  it('the fallback phrase and every template output are clean', () => {
    expect(bannedIn(FALLBACK_LINE)).toEqual([]);
    expect(bannedIn(composeLine({}).text)).toEqual([]);
    expect(bannedIn(composeLine({ place: 'side gate', clothing: 'dark jacket' }).text)).toEqual([]);
  });

  it('no threat, police, weapon or protected-characteristic word ever reaches the line', () => {
    const banned = [
      'police', 'intruder', 'weapon', 'gun', 'leave now', 'get out', 'suspicious', 'trespasser',
      'man', 'woman', 'young man', 'elderly woman', 'teenager', 'black man', 'asian', 'muslim',
      'disabled', 'wheelchair', 'accent', 'homeless', 'drunk', 'tall', 'beard',
    ]; // prettier-ignore
    for (const b of banned) {
      for (const slots of [
        { place: b },
        { clothing: b },
        { place: `near ${b}`, clothing: `${b} jacket` },
      ]) {
        const line = composeLine(slots);
        expect(bannedIn(line.text, { clothing: true }), `${b} in ${JSON.stringify(slots)}`).toEqual(
          [],
        );
        for (const word of b.split(' ')) {
          if (['black', 'white'].includes(word)) continue;
          expect(line.text.toLowerCase()).not.toMatch(new RegExp(`\\b${word}\\b`));
        }
      }
    }
  });

  it('a slot with a banned word is dropped and reported, the rest of the line stays', () => {
    const l = composeLine({ place: 'side gate', clothing: 'young man in a hoodie' });
    expect(l.dropped).toEqual(['clothing']);
    expect(l.usedFallback).toBe(false);
    expect(l.text).toBe("You're on camera at the side gate. The owner has been notified.");
  });

  it('black and white are allowed only as a garment colour, once', () => {
    expect(composeLine({ clothing: 'black jacket' }).text).toContain('a black jacket');
    expect(composeLine({ clothing: 'white t-shirt' }).text).toContain('a white t-shirt');
    expect(composeLine({ clothing: 'black' }).dropped).toEqual(['clothing']);
    expect(composeLine({ clothing: 'white man' }).dropped).toEqual(['clothing']);
    expect(composeLine({ clothing: 'black jacket and black hat' }).dropped).toEqual(['clothing']);
    expect(composeLine({ place: 'black gate' }).dropped).toEqual(['place']); // never in a place
  });

  it('matches whole words only, so ordinary words are not blocked', () => {
    expect(bannedIn('the manager is shortly home')).toEqual([]);
    expect(composeLine({ clothing: 'gray shorts' }).text).toContain('a gray shorts');
    expect(bannedIn('man')).toEqual(['man']);
  });

  it('a slot cannot smuggle a sentence: punctuation, digits, newlines and length are refused', () => {
    for (const bad of [
      'gate. Leave now',
      'gate\nYou must go',
      'gate 3',
      'gate; please go',
      'gate you must go',
      'gate\tnow',
      'one two three four five',
      'x'.repeat(41),
      '<b>gate</b>',
      '   ',
    ]) {
      expect(composeLine({ place: bad }).text).toBe(
        "You're on camera. The owner has been notified.",
      );
    }
  });

  it('the stub speaker plays nothing and says so', async () => {
    const log = vi.fn();
    const r = await createStubSpeaker(log).speak('hello');
    expect(r).toEqual({ ok: true, detail: 'stub: nothing was played' });
    expect(log).toHaveBeenCalledWith('hello');
  });
});
