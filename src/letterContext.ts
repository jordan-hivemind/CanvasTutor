// Context for character matching: a weight (0..1) per candidate character, from what's next to it.
//  - next to digits, digits are favoured; next to letters, letters are (z vs 2, l vs 1, o vs 0, s vs 5)
//  - inside a word, letters that commonly follow the letters before it are favoured
// These only nudge the match; a clearly drawn character still wins.

const WORDS = `the of and to in is it that for as with was on be by at this are from or an have not but
which they he she we you all one can there their has had were been more if will would about out up
so what when who them these some other into than then its only also time two over new may use used
like first any how could each just make made such most where after see way well even because many
very through our because those both between under same while still last long down own much great
here should does did take know why give work part number around find value point line given equal
equals sum product total rate speed velocity acceleration force mass energy work power momentum
gravity gravitational orbit orbital radius distance displacement position time period frequency
wave light star stars sun earth moon planet planets galaxy solar mass luminosity temperature
pressure density volume area length width height angle degree degrees radian radians vector vectors
scalar matrix matrices determinant eigenvalue gradient divergence curl partial derivative integral
limit function functions domain range slope tangent normal plane surface curve level contour
double triple constant variable variables solve solution answer question example problem problems
step steps next check therefore thus since let assume find prove show note answer theorem
proof lemma definition sin cos tan log ln exp sqrt max min max ratio unit units meter meters
second seconds kilogram newton joule watt kelvin initial final average net change delta
theta alpha beta omega phi pi lambda mu sigma rho tau x y z dx dy dz dt kinetic potential
spring friction tension normal weight circular motion projectile free fall height maximum minimum
critical local global increase decrease positive negative zero half twice square cube root
homework lecture notes chapter section page textbook exam test quiz review practice`

const counts = new Map<string, Map<string, number>>()
const add = (ctx: string, ch: string) => {
  let m = counts.get(ctx)
  if (!m) counts.set(ctx, (m = new Map()))
  m.set(ch, (m.get(ch) ?? 0) + 1)
}
for (const w of WORDS.split(/\s+/).filter(Boolean)) {
  const s = '^' + w.toLowerCase()
  for (let i = 1; i < s.length; i++) {
    add(s[i - 1], s[i]) // previous letter (or word start)
    if (i >= 2) add(s.slice(i - 2, i), s[i]) // previous two letters
  }
}

const isDigit = (c: string) => /^[0-9]$/.test(c)
const isLetter = (c: string) => /^[a-zA-Z]$/.test(c)

/** Distribution over the next letter given the letters just before it in the word, normalised so the most likely is 1. */
function nextLetter(prefix: string): Map<string, number> | null {
  const p = '^' + prefix.toLowerCase()
  const m = counts.get(p.slice(-2)) ?? counts.get(p.slice(-1))
  if (!m) return null
  const max = Math.max(...m.values())
  return new Map([...m].map(([k, v]) => [k, v / max]))
}

/**
 * Weight function for the recogniser. `before` is the run of characters immediately to the left
 * on the same line (nearest last), e.g. "the" or "12".
 */
export function contextPrior(before: string): ((ch: string) => number) | undefined {
  if (!before) return undefined
  const prev = before[before.length - 1]
  if (isDigit(prev)) return (ch) => (isDigit(ch) || '.+-=×÷()'.includes(ch) ? 0.6 : 0)
  if (isLetter(prev)) {
    const word = before.match(/[a-zA-Z]+$/)?.[0] ?? ''
    const dist = nextLetter(word)
    return (ch) => {
      if (!isLetter(ch)) return 0
      const p = dist?.get(ch.toLowerCase()) ?? 0
      return 0.4 + 0.6 * p
    }
  }
  return undefined
}
