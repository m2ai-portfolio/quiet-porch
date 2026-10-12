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
// Slots are a CLOSED vocabulary, not a deny-list. A deny-list lets through every word nobody
// thought of ("pistol", "blind", a hyphenated "police-jacket"); a closed list can only ever say
// what was approved. The banned-word list above stays as a second check on the finished line.
const COLOURS = new Set([
  'black', 'white', 'gray', 'grey', 'red', 'blue', 'green', 'brown', 'tan', 'beige', 'navy',
  'orange', 'yellow', 'purple', 'pink', 'dark', 'light', 'bright', 'striped', 'plaid',
]); // prettier-ignore
const GARMENTS = new Set([
  'jacket', 'coat', 'hoodie', 'sweatshirt', 'sweater', 'shirt', 'tee', 't-shirt', 'top', 'vest',
  'dress', 'skirt', 'hat', 'cap', 'beanie', 'hood', 'scarf', 'backpack', 'bag',
]); // prettier-ignore
// Plural garments take no article: "I can see gray shorts".
const PLURAL_GARMENTS = new Set([
  'pants', 'jeans', 'shorts', 'trousers', 'gloves', 'shoes', 'boots', 'sneakers',
]); // prettier-ignore

// Where the person is. Callers may pass their own list (the zone labels from config).
export const DEFAULT_PLACES = [
  'side gate', 'front gate', 'front steps', 'front door', 'front yard', 'back yard', 'back door',
  'driveway', 'porch', 'walkway', 'garage door', 'fence',
]; // prettier-ignore

const WORD_RE = /[a-z0-9']+(?:-[a-z0-9']+)*/g;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

// Returns the banned entries found, empty when the text is clean. Entries are matched on word
// boundaries so "manage" does not trip "man" and "shortly" does not trip "short". "black" and
// "white" are banned as descriptions of a person; as a garment colour they are allowed only
// directly before a garment word, once (the slot allow-list is what really guards them).
export function bannedIn(text: string): string[] {
  const w = words(text);
  const joined = ` ${w.join(' ')} `;
  const hits: string[] = [];
  for (const phrase of BANNED_PHRASES) {
    const p = phrase.toLowerCase();
    if (!joined.includes(` ${p} `)) continue;
    if (p === 'black' || p === 'white') {
      const idx = w.indexOf(p);
      const next = w[idx + 1];
      const garment = next !== undefined && (GARMENTS.has(next) || PLURAL_GARMENTS.has(next));
      if (w.filter((x) => x === p).length === 1 && garment) continue;
    }
    hits.push(phrase);
  }
  return hits;
}

interface Item {
  colour?: string;
  garment: string;
}

// "dark jacket", "gray shorts", "hat", or two of them joined with " and ". Anything else is
// refused whole: no partial credit, no hyphens, no digits, no extra words.
function parseClothing(raw: string | undefined): Item[] | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  if (!/^[a-z]+(?:-[a-z]+)?(?: [a-z]+(?:-[a-z]+)?)*$/.test(t) || t.length > 40) return undefined;
  const parts = t.split(' and ');
  if (parts.length > 2) return undefined;
  const items: Item[] = [];
  for (const part of parts) {
    const w = part.split(' ');
    const garment = w.at(-1)!;
    const colours = w.slice(0, -1);
    if (!GARMENTS.has(garment) && !PLURAL_GARMENTS.has(garment)) return undefined;
    if (colours.length > 1 || (colours[0] !== undefined && !COLOURS.has(colours[0]))) {
      return undefined;
    }
    items.push({ colour: colours[0], garment });
  }
  // The same colour word twice ("white hat and white coat") is refused: one colour, once.
  const used = items.map((i) => i.colour).filter(Boolean);
  if (new Set(used).size !== used.length) return undefined;
  return items;
}

function phraseOf(i: Item): string {
  return i.colour ? `${i.colour} ${i.garment}` : i.garment;
}

function parsePlace(raw: string | undefined, places: string[]): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase().replace(/^the /, '');
  return places.includes(t) ? t : undefined;
}

function clothingSentence(items: Item[]): string {
  const phrases = items.map(phraseOf);
  const lead = items[0];
  const article = PLURAL_GARMENTS.has(lead.garment)
    ? ''
    : /^[aeiou]/.test(phrases[0])
      ? 'an '
      : 'a ';
  const first = `${article}${phrases[0]}`;
  if (items.length === 1) return first;
  const second = items[1];
  const art2 = PLURAL_GARMENTS.has(second.garment)
    ? ''
    : /^[aeiou]/.test(phrases[1])
      ? 'an '
      : 'a ';
  return `${first} and ${art2}${phrases[1]}`;
}

export interface ComposedLine {
  text: string;
  usedFallback: boolean;
  dropped: string[]; // slots rejected by the filter, for the ledger and the friction log
}

// The template. "You're on camera at <place>." plus, when a clothing slot survived,
// " I can see <clothing>." and always the closing fact. Nothing else is ever said.
export function composeLine(slots: LineSlots, opts: { places?: string[] } = {}): ComposedLine {
  const dropped: string[] = [];
  const place = parsePlace(slots.place, opts.places ?? DEFAULT_PLACES);
  if (slots.place && !place) dropped.push('place');
  const items = parseClothing(slots.clothing);
  if (slots.clothing && !items) dropped.push('clothing');

  const where = place ? ` at the ${place}` : '';
  const sees = items ? ` I can see ${clothingSentence(items)}.` : '';
  const text = `You're on camera${where}.${sees} The owner has been notified.`;

  // Second check on the finished line, whatever the slots said.
  if (bannedIn(text).length > 0) return { text: FALLBACK_LINE, usedFallback: true, dropped };
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
