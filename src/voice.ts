// The porch speaks (F2, Principle 3): one calm line, composed from a FIXED template and filled
// with what the camera saw. The model never writes the sentence; it only supplies two short
// slots (where the person is, what they wear), and every slot and the finished line pass a
// banned-word filter. A line that fails the filter is replaced by the cached fallback phrase,
// so the porch never says something we did not approve.
//
// Built in Wave 1 behind a STUB for playback: nothing here calls Polly or the Pi speaker, and
// the ladder still plays its bark clip. Wiring (replace play_clip, retune LEVEL_DWELL_MS to
// 0/0/10/20/40 s, synthesize with Polly) waits for Matt per the brief.

export const FALLBACK_LINE = "You're on camera. The owner has been notified.";

// What the model may fill in. Both are optional; an empty slot is simply left out.
export interface LineSlots {
  place?: string; // "the side gate", "the front steps"
  clothing?: string; // "a dark jacket"
}

// Words and phrases the porch never says, in any slot or in the finished line. Matching is on
// whole words, case-insensitive; multi-word entries match as a phrase. The list errs wide:
// a rejected line costs only the fallback phrase.
const BANNED_PHRASES = [
  // threats and escalation
  'police',
  'cops',
  'sheriff',
  '911',
  'arrest',
  'arrested',
  'shoot',
  'shot',
  'kill',
  'hurt',
  'harm',
  'attack',
  'weapon',
  'gun',
  'knife',
  'armed',
  'dangerous',
  'intruder',
  'trespasser',
  'trespassing',
  'burglar',
  'thief',
  'criminal',
  'suspect',
  'suspicious',
  'leave now',
  'get out',
  'we will',
  "i'll",
  'warning',
  'alarm',
  // commands and ultimatums: a slot names a place or a garment, it never gives an instruction
  'must',
  'leave',
  'go',
  'away',
  'stop',
  'run',
  'now',
  'please',
  'move',
  'else',
  // protected characteristics: the line describes clothing and position only
  'man',
  'woman',
  'male',
  'female',
  'boy',
  'girl',
  'guy',
  'lady',
  'young',
  'old',
  'elderly',
  'teen',
  'teenager',
  'child',
  'black',
  'white',
  'asian',
  'hispanic',
  'latino',
  'latina',
  'indian',
  'arab',
  'african',
  'european',
  'muslim',
  'christian',
  'jewish',
  'hindu',
  'disabled',
  'wheelchair',
  'pregnant',
  'fat',
  'thin',
  'tall',
  'short',
  'bald',
  'beard',
  'accent',
  'gay',
  'straight',
  'foreign',
  'immigrant',
  'homeless',
  'drunk',
  'high',
];

// Colour words are fine for clothing ("a white shirt", "a black hat") but are banned words as
// descriptions of a person. Only these two are allowed through, and only inside the clothing
// slot, followed by a garment word from the list below.
const COLOUR_AMBIGUOUS = new Set(['black', 'white']);
const GARMENTS = new Set([
  'jacket',
  'coat',
  'hoodie',
  'sweatshirt',
  'sweater',
  'shirt',
  'tee',
  't-shirt',
  'top',
  'vest',
  'pants',
  'jeans',
  'shorts',
  'trousers',
  'dress',
  'skirt',
  'hat',
  'cap',
  'beanie',
  'hood',
  'scarf',
  'gloves',
  'backpack',
  'bag',
  'shoes',
  'boots',
  'sneakers',
]);

const WORD_RE = /[a-z0-9']+(?:-[a-z0-9']+)*/g;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

// Returns the banned entries found, empty when the text is clean. Entries are matched on word
// boundaries so "manage" does not trip "man" and "shortly" does not trip "short".
export function bannedIn(text: string, opts: { clothing?: boolean } = {}): string[] {
  const w = words(text);
  const joined = ` ${w.join(' ')} `;
  const hits: string[] = [];
  for (const phrase of BANNED_PHRASES) {
    const p = phrase.toLowerCase();
    if (!joined.includes(` ${p} `)) continue;
    if (opts.clothing && COLOUR_AMBIGUOUS.has(p)) {
      // allowed only as "black/white <garment>" in the clothing slot
      const idx = w.indexOf(p);
      const next = w[idx + 1];
      const ok = w.filter((x) => x === p).length === 1 && next !== undefined && GARMENTS.has(next);
      if (ok) continue;
    }
    hits.push(phrase);
  }
  return hits;
}

const SLOT_MAX = 40;
const SLOT_MAX_WORDS = 4;

// A slot is short, plain words only: no digits, no punctuation that could smuggle a sentence.
function cleanSlot(raw: string | undefined, kind: 'place' | 'clothing'): string | undefined {
  if (!raw) return undefined;
  // Any whitespace other than a plain space (newline, tab, no-break space) is refused, not
  // flattened: flattening would turn "gate\nYou must go" into a sentence.
  const t = raw.trim();
  if (t.length === 0 || t.length > SLOT_MAX) return undefined;
  if (!/^[A-Za-z'-]+(?: [A-Za-z'-]+)*$/.test(t)) return undefined;
  if (t.split(' ').length > SLOT_MAX_WORDS) return undefined;
  if (bannedIn(t, { clothing: kind === 'clothing' }).length > 0) return undefined;
  return t.toLowerCase();
}

function withArticle(phrase: string): string {
  return /^(a|an|the|some|his|her|their)\s/.test(phrase)
    ? phrase
    : /^[aeiou]/.test(phrase)
      ? `an ${phrase}`
      : `a ${phrase}`;
}

export interface ComposedLine {
  text: string;
  usedFallback: boolean;
  dropped: string[]; // slots rejected by the filter, for the ledger and the friction log
}

// The template. "You're on camera at <place>." plus, when a clothing slot survived,
// " I can see <clothing>." and always the closing fact. Nothing else is ever said.
export function composeLine(slots: LineSlots): ComposedLine {
  const dropped: string[] = [];
  const place = cleanSlot(slots.place, 'place');
  if (slots.place && !place) dropped.push('place');
  const clothing = cleanSlot(slots.clothing, 'clothing');
  if (slots.clothing && !clothing) dropped.push('clothing');

  const where = place ? ` at ${place.startsWith('the ') ? place : `the ${place}`}` : '';
  const sees = clothing ? ` I can see ${withArticle(clothing)}.` : '';
  const text = `You're on camera${where}.${sees} The owner has been notified.`;

  // The finished line is checked again as a whole: a slot pair could read badly together.
  if (bannedIn(text, { clothing: true }).length > 0) {
    return { text: FALLBACK_LINE, usedFallback: true, dropped };
  }
  return { text, usedFallback: false, dropped };
}

// Playback seam. Wave 2 replaces the stub with Polly synthesis and the Pi speaker.
export interface Speaker {
  speak(text: string): Promise<{ ok: boolean; detail?: string }>;
}

// STUB (Wave 1, by design): records what would be said and plays nothing.
export function createStubSpeaker(log: (text: string) => void = () => {}): Speaker {
  return {
    async speak(text) {
      log(text);
      return { ok: true, detail: 'stub: nothing was played' };
    },
  };
}
