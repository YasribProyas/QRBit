/**
 * Safety-phrase word list (PLAN.md §11.6).
 *
 * Exactly 256 words, so one byte of HKDF output maps to one word via
 * `WORDLIST[byte]` — no modulo bias, no rejection sampling, and a first-word
 * index that is statistically uniform.
 *
 * Selection constraints (all machine-checked in `crypto.test.ts`):
 *   - exactly 256 entries, all distinct
 *   - 3–8 characters, lowercase, ASCII letters only
 *   - no two words within Levenshtein distance 2 of each other, so nothing in
 *     this list can be confused with another entry when a phrase is read aloud
 *     across a table (PLAN.md §11.6 wants unambiguous spoken words)
 *   - no two neighbouring entries share a four-letter opening, so a run like
 *     whisk/whisper/whistle cannot leave the list with a comparison a hurried
 *     user has to squint at
 *   - concrete nouns and simple adjectives, ordered alphabetically for review
 *
 * The order is load-bearing: index == byte value.
 */
const WORDS: readonly string[] = [
  'ace', 'acorn', 'album', 'alley', 'almond', 'alpha', 'amber', 'anchor',
  'angel', 'animal', 'ankle', 'apron', 'baby', 'badge', 'baker', 'balance',
  'balcony', 'bamboo', 'banana', 'banjo', 'barrel', 'basalt', 'beach', 'bell',
  'cabbage', 'cabin', 'cactus', 'camel', 'canoe', 'canvas', 'cap', 'captain',
  'caravan', 'cargo', 'carpet', 'carving', 'dagger', 'daisy', 'dart', 'deer',
  'delta', 'denim', 'dessert', 'diamond', 'diesel', 'dimple', 'dingo', 'dinner',
  'eagle', 'echo', 'eclipse', 'egg', 'elbow', 'elder', 'elephant', 'emerald',
  'engine', 'envelope', 'eraser', 'fabric', 'feather', 'fence', 'fern', 'fiddle',
  'field', 'fish', 'flag', 'flamingo', 'flavor', 'fleet', 'flock', 'galaxy',
  'gallop', 'garage', 'garden', 'garlic', 'gazelle', 'gem', 'giraffe', 'glacier',
  'glass', 'globe', 'goat', 'hail', 'hamster', 'harbor', 'harvest', 'hatch',
  'head', 'helmet', 'hickory', 'hippo', 'hive', 'hobby', 'hockey', 'igloo',
  'impala', 'ink', 'insect', 'island', 'ivory', 'jacket', 'jaguar', 'jasmine',
  'jeans', 'jester', 'jewel', 'jigsaw', 'job', 'journal', 'juice', 'jungle',
  'juniper', 'kangaroo', 'kayak', 'kettle', 'kilt', 'kimono', 'kitten', 'knee',
  'knight', 'koala', 'ladder', 'ladybug', 'lagoon', 'lamb', 'lantern', 'laptop',
  'laundry', 'lemon', 'leopard', 'library', 'lid', 'linen', 'machine', 'magnet',
  'mallard', 'mammoth', 'marble', 'marina', 'marsh', 'meadow', 'medal', 'merchant',
  'meteor', 'midday', 'napkin', 'narwhal', 'needle', 'nest', 'nickel', 'ninja',
  'north', 'notebook', 'nutmeg', 'nylon', 'oasis', 'oboe', 'ocean', 'octopus',
  'office', 'onion', 'onyx', 'opal', 'orange', 'orbit', 'orchid', 'osprey',
  'paint', 'pancake', 'panda', 'panther', 'parrot', 'pastry', 'patio', 'pavement',
  'peacock', 'peanut', 'pearl', 'pebble', 'quake', 'quartz', 'queen', 'quill',
  'quiver', 'rabbit', 'raccoon', 'radar', 'radish', 'rainbow', 'raven', 'reindeer',
  'ribbon', 'roof', 'rosemary', 'rowboat', 'rubber', 'saffron', 'salad', 'sapphire',
  'sardine', 'satchel', 'saucer', 'sausage', 'scale', 'school', 'scissors', 'scooter',
  'scout', 'tablet', 'tailor', 'tapestry', 'task', 'teacup', 'teapot', 'tennis',
  'terrace', 'thicket', 'thimble', 'throne', 'thumb', 'umbrella', 'unicycle', 'uniform',
  'urban', 'utensil', 'valve', 'vanilla', 'vault', 'vehicle', 'vendor', 'verse',
  'vinegar', 'violet', 'viper', 'volcano', 'vulture', 'waffle', 'walnut', 'weasel',
  'wheel', 'whisk', 'whole', 'wiggle', 'window', 'wombat', 'worm', 'wrench',
  'yacht', 'yawn', 'yogurt', 'yolk', 'zebra', 'zigzag', 'zither', 'zone',
]

/** Number of words in the list; also the number of distinct byte values. */
export const WORDLIST_LENGTH = 256

if (WORDS.length !== WORDLIST_LENGTH) {
  // Fail at import time rather than showing a subtly biased phrase.
  throw new Error(`wordlist: expected ${WORDLIST_LENGTH} words, got ${WORDS.length}`)
}

/** Frozen 256-word list indexed by byte value (0–255). */
export const WORDLIST: readonly string[] = Object.freeze(WORDS)
