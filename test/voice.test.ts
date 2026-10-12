import { describe, expect, it, vi } from 'vitest';
import {
  bannedIn,
  composeLine,
  createStubSpeaker,
  DEFAULT_PLACES,
  FALLBACK_LINE,
} from '../src/voice.ts';

const CLEAN = "You're on camera. The owner has been notified.";

describe('the porch speaks: fixed template, closed vocabulary', () => {
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
    expect(composeLine({}).text).toBe(CLEAN);
  });

  it('plural garments take no article, and two items may be joined with "and"', () => {
    expect(composeLine({ clothing: 'gray shorts' }).text).toContain('I can see gray shorts.');
    expect(composeLine({ clothing: 'red hat and blue jeans' }).text).toContain(
      'I can see a red hat and blue jeans.',
    );
    expect(composeLine({ clothing: 'black jacket' }).text).toContain('a black jacket');
    expect(composeLine({ clothing: 'white t-shirt' }).text).toContain('a white t-shirt');
  });

  it('the fallback phrase and every template output are clean', () => {
    expect(bannedIn(FALLBACK_LINE)).toEqual([]);
    expect(bannedIn(composeLine({}).text)).toEqual([]);
    expect(bannedIn(composeLine({ place: 'side gate', clothing: 'black jacket' }).text)).toEqual(
      [],
    );
    for (const p of DEFAULT_PLACES) expect(bannedIn(composeLine({ place: p }).text)).toEqual([]);
  });

  it('refuses everything outside the vocabulary, including what review found', () => {
    const attempts = [
      // hyphen bypasses
      'police-jacket', 'gun-hoodie', 'old-man jacket', 'young-looking hoodie', 'kill-switch hat',
      // person descriptions and protected characteristics
      'young man in a hoodie', 'blind person', 'heavyset', 'obese', 'chinese', 'jew', 'sikh',
      'nun', 'gentleman', 'white man', 'black man', 'a kid', 'senior', 'blonde',
      // threats and weapons
      'pistol', 'rifle', 'machete', 'crowbar', 'bomb', 'cop', 'prowler', 'nazi', 'kkk hood',
      'gang jacket', 'police jacket',
      // commands and filler
      'get lost', 'back off', 'scram', 'go away now', 'mask', 'naked',
      // slot pairs and fragments
      'white hat black hat', 'a', "'", '-', 'jacket jacket', 'dark light jacket', 'red hat and red coat',
      'hat and coat and scarf',
    ]; // prettier-ignore
    for (const bad of attempts) {
      const line = composeLine({ clothing: bad });
      expect(line.text, `clothing "${bad}"`).toBe(CLEAN);
      expect(line.dropped).toEqual(['clothing']);
    }
  });

  it('a place must be one of the approved places', () => {
    for (const bad of [
      'black gate',
      'the your bedroom',
      'the nursery',
      'the mosque',
      'the ghetto',
      'the baby',
      "the your daughter's window",
      'side  gate',
      'side-gate',
      'a',
    ]) {
      const line = composeLine({ place: bad });
      expect(line.text, `place "${bad}"`).toBe(CLEAN);
      expect(line.dropped).toEqual(['place']);
    }
    // The caller's own zone labels replace the default list.
    expect(composeLine({ place: 'side yard' }, { places: ['side yard'] }).text).toBe(
      "You're on camera at the side yard. The owner has been notified.",
    );
    expect(composeLine({ place: 'side gate' }, { places: ['side yard'] }).dropped).toEqual([
      'place',
    ]);
  });

  it('a rejected slot is reported and the rest of the line stays', () => {
    const l = composeLine({ place: 'side gate', clothing: 'young man in a hoodie' });
    expect(l.dropped).toEqual(['clothing']);
    expect(l.usedFallback).toBe(false);
    expect(l.text).toBe("You're on camera at the side gate. The owner has been notified.");
  });

  it('a slot cannot smuggle a sentence: punctuation, digits, newlines and length are refused', () => {
    for (const bad of [
      'gate. Leave now',
      'gate\nYou must go',
      'gate 3',
      'gate; please go',
      'x'.repeat(41),
      '<b>gate</b>',
      '   ',
      'gate\tnow',
    ]) {
      expect(composeLine({ place: bad }).text).toBe(CLEAN);
      expect(composeLine({ clothing: bad }).text).toBe(CLEAN);
    }
  });

  it('the banned-word check still catches a bad finished line and matches whole words only', () => {
    expect(bannedIn('the manager is shortly home')).toEqual([]);
    expect(bannedIn('man')).toEqual(['man']);
    expect(bannedIn('call the police-now')).toEqual([]); // hyphens are the slot parser's job
    expect(bannedIn('a white man')).toContain('man');
    expect(bannedIn('I can see a white jacket')).toEqual([]);
    expect(bannedIn('white and white jacket')).toContain('white');
  });

  it('the stub speaker plays nothing and says so', async () => {
    const log = vi.fn();
    const r = await createStubSpeaker(log).speak('hello');
    expect(r).toEqual({ ok: true, detail: 'stub: nothing was played' });
    expect(log).toHaveBeenCalledWith('hello');
  });

  it('words that imply a gender, read as hate imagery or loot are not in the vocabulary (round 2)', () => {
    for (const bad of [
      'dark hood',
      'white hood',
      'black hood',
      'plaid hood',
      'tan dress',
      'pink skirt',
      'red top',
      'dark bag',
      'striped bag',
      'light hood and dark bag',
      'tan jacket',
      'dark backpack',
    ]) {
      expect(composeLine({ clothing: bad }).text, bad).toBe(CLEAN);
    }
    expect(composeLine({ clothing: 'dark hoodie' }).text).toContain('a dark hoodie');
  });

  it('a caller-supplied places list is held to the approved place words (round 2)', () => {
    for (const bad of [
      'gate. you will regret this',
      'nursery',
      'bedroom window',
      'kid room',
      'alley behind the dumpster, watching you',
    ]) {
      const l = composeLine({ place: bad }, { places: [bad] });
      expect(l.text, bad).toBe(CLEAN);
      expect(l.dropped).toEqual(['place']);
    }
    expect(
      composeLine({ place: 'side yard' }, { places: ['side yard', 'nursery'] }).text,
    ).toContain('at the side yard');
  });

  it('slots from model JSON that are not strings never crash the escalation (round 2)', () => {
    for (const slots of [
      { place: 5 },
      { clothing: ['a'] },
      { clothing: {} },
      { place: null, clothing: null },
      null,
      undefined,
      'x',
      7,
    ]) {
      expect(() => composeLine(slots as never)).not.toThrow();
      expect(composeLine(slots as never).text).toBe(CLEAN);
    }
  });

  it('never throws, whatever it is given, and refuses a garment twice (third pass)', () => {
    const getter = {
      get clothing(): string {
        throw new Error('boom');
      },
    };
    expect(composeLine(getter).text).toBe(FALLBACK_LINE);
    expect(composeLine({}, null as never).text).toBe(CLEAN);
    expect(composeLine({ place: 'side gate' }, { places: 'x' as never }).text).toBe(FALLBACK_LINE);
    expect(composeLine({ clothing: 'jacket and black jacket' }).text).toBe(CLEAN);
    expect(composeLine({ clothing: 'jacket and jacket' }).text).toBe(CLEAN);
    expect(composeLine({ clothing: 'brown shirt' }).text).toBe(CLEAN);
  });
});
