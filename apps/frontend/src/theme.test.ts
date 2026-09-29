/**
 * The token layer's consistency tests (DESIGN.md is the normative source).
 *
 * Three files describe the same design system, and two of them cannot reference the third:
 *
 *   - `DESIGN.md`'s YAML frontmatter — the list every value must appear in, and the only
 *     place a value is *decided*;
 *   - `styles.css` — the `--qrbit-*` custom properties components consume, keyed to a
 *     scheme by `[data-theme]`;
 *   - `theme.ts` — Mantine's theme object, which must carry real colours (Mantine measures
 *     them in JavaScript to choose label colours and auto-contrast, so a `var()` there
 *     would be measured as garbage).
 *
 * The bridge therefore has two directions, and this file pins both: Mantine's *semantic
 * slots* are pointed at the CSS variables by `qrbitCssVariablesResolver` (checked below by
 * running the resolver and reading what it emits), and its *colour ramps* are duplicated
 * literals — which is exactly the situation DESIGN.md was written to end, so the
 * duplication is only allowed while it is provably equal. Every assertion below is a
 * comparison against a value parsed out of DESIGN.md, not a re-typed copy of it: if a lane
 * changes one of the three files, or edits the document, this test says which name broke.
 *
 * It also carries the cheap structural guards that a CSS file cannot make for itself: the
 * token set is closed (no `var(--qrbit-*)` use without a definition), no rule reached a
 * network origin (`font-src 'self'` / `style-src 'self'` in dist/_headers), and the fonts
 * are the two local files `index.html` preloads.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, mergeMantineTheme, type CssVariables } from '@mantine/core'

import { THEME_STORAGE_KEY, qrbitCssVariablesResolver, theme } from './theme'

const designSource = readFileSync(new URL('../../../DESIGN.md', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const themeSource = readFileSync(new URL('./theme.ts', import.meta.url), 'utf8')

/**
 * Strips comments, because these next guards are about what a file *does*. This stylesheet
 * and this module both explain, in prose, the URLs and the retired palette they do not
 * contain, and a guard that trips on an explanation is a guard nobody can keep.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const cssCode = codeOnly(cssSource)
const themeCode = codeOnly(themeSource)

/** The merged theme the provider actually renders with, typed as a complete theme. */
const merged = mergeMantineTheme(DEFAULT_THEME, theme)

/** Reads one colour ramp by name, and says so when the theme stopped defining it. */
function ramp(name: string): readonly string[] {
  const value: readonly string[] | undefined = merged.colors[name]
  if (value === undefined) {
    throw new Error(`test bug: theme.colors.${name} is not defined`)
  }
  return value
}

/** Mantine types its variable bags with `--*` keys; this is the lookup that needs none. */
function slotsOf(block: CssVariables): Map<string, string> {
  const found = new Map<string, string>()
  for (const [name, value] of Object.entries(block)) {
    found.set(name, String(value))
  }
  return found
}

const hex = (value: string): string => value.trim().toLowerCase()

/** DESIGN.md's frontmatter: the normative block, between the first pair of `---` rules. */
function frontmatter(): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(designSource)
  if (match === null || match[1] === undefined) {
    throw new Error('test bug: DESIGN.md has no YAML frontmatter block to read tokens from')
  }
  return match[1]
}

/** A two-space-indented scalar inside a top-level section, e.g. `colors: signal: "#1D4ED8"`. */
function designScalar(section: string, key: string): string {
  const pattern = new RegExp(
    `^${section}:\\r?\\n(?:[^\\r\\n]*\\r?\\n)*?^  ${key}:\\s*(.+)$`,
    'm',
  )
  const match = pattern.exec(frontmatter())
  const value = match?.[1]
  if (value === undefined) {
    throw new Error(`test bug: DESIGN.md frontmatter has no ${section}.${key} to compare against`)
  }
  return value.replace(/^"|"$/g, '').replace(/^"|"$/g, '')
}

/** The five declarations of one typography role. */
function designRole(role: string): Record<string, string> {
  const block = new RegExp(`^  ${role}:\\r?\\n((?:^    .+\\r?\\n?)+)`, 'm').exec(frontmatter())
  const body = block?.[1]
  if (body === undefined) {
    throw new Error(`test bug: DESIGN.md frontmatter has no typography.${role} block`)
  }

  const declarations: Record<string, string> = {}
  for (const line of body.split(/\r?\n/)) {
    const pair = /^    ([A-Za-z]+):\s*(.+)$/.exec(line)
    if (pair !== null && pair[1] !== undefined && pair[2] !== undefined) {
      declarations[pair[1]] = pair[2].replace(/^"|"$/g, '')
    }
  }
  return declarations
}

/** The `:root` token block — the first one, which is the block that defines values. */
function rootBlock(): string {
  const match = /^:root \{\r?\n([\s\S]*?)^\}/m.exec(cssSource)
  const body = match?.[1]
  if (body === undefined) {
    throw new Error('test bug: styles.css has no `:root { … }` block to read light tokens from')
  }
  return body
}

function darkBlock(): string {
  const match = /^\[data-theme='dark'\] \{\r?\n([\s\S]*?)^\}/m.exec(cssSource)
  const body = match?.[1]
  if (body === undefined) {
    throw new Error('test bug: styles.css has no `[data-theme=\'dark\']` block to read dark tokens from')
  }
  return body
}

function declaredIn(block: string, name: string): string | undefined {
  const match = new RegExp(`^  --${name}:\\s*([^;]+);`, 'm').exec(block)?.[1]
  return match?.trim()
}

/** The 18 names DESIGN.md's "Do" list says every component reads, split by whether the
 * document gives them one value or one per scheme. */
const SURFACES = ['canvas', 'raised', 'sunken', 'selected'] as const
const INKS = ['ink', 'ink-secondary', 'ink-muted'] as const
const LINES = ['border', 'border-strong'] as const
const ACCENTS = ['signal', 'signal-deep', 'signal-subtle'] as const
const STATUSES = ['success', 'warning', 'danger', 'locked'] as const
const ROLES = [
  'display',
  'headline',
  'title',
  'body',
  'body-secondary',
  'label',
  'data',
] as const

describe('styles.css carries DESIGN.md exactly', () => {
  it('declares every light surface, ink, line, accent and status with the documented value', () => {
    for (const name of [...SURFACES, ...INKS, ...LINES]) {
      const documented = designScalar('colors', `light-${name}`)
      expect(declaredIn(rootBlock(), `qrbit-${name}`), `--qrbit-${name}`).toBe(documented)
    }
    // The accent and the four statuses are written once in DESIGN.md, not once per scheme:
    // #1D4ED8 means *this is the action* in either world.
    for (const name of [...ACCENTS, ...STATUSES]) {
      const documented = designScalar('colors', name)
      expect(declaredIn(rootBlock(), `qrbit-${name}`), `--qrbit-${name}`).toBe(documented)
    }
  })

  it('declares the dark scheme under [data-theme], not in a media query', () => {
    const dark = darkBlock()
    for (const name of [...SURFACES, ...INKS, ...LINES]) {
      const documented = designScalar('colors', `dark-${name}`)
      expect(declaredIn(dark, `qrbit-${name}`), `--qrbit-${name} (dark)`).toBe(documented)
    }

    // The hues mean the same thing in both schemes, so the dark block must not restate them.
    for (const name of [...ACCENTS, ...STATUSES]) {
      expect(declaredIn(dark, `qrbit-${name}`), `--qrbit-${name} must stay scheme-independent`).toBeUndefined()
    }

    expect(cssSource).not.toMatch(/prefers-color-scheme[\s\S]*\{[\s\S]*--qrbit-/)
  })

  it('ships the two documented shadows and nothing else in the dark vocabulary', () => {
    expect(declaredIn(rootBlock(), 'qrbit-shadow-sheet')).toBe(
      '0 1px 2px rgba(11, 18, 32, 0.06), 0 8px 24px -8px rgba(11, 18, 32, 0.14)',
    )
    expect(declaredIn(rootBlock(), 'qrbit-shadow-lift')).toBe('0 1px 3px rgba(11, 18, 32, 0.1)')
    // DESIGN.md: dark conveys depth through surface steps and hairlines, not shadows.
    expect(declaredIn(darkBlock(), 'qrbit-shadow-sheet')).toContain('1px var(--qrbit-border)')
    expect(declaredIn(darkBlock(), 'qrbit-shadow-lift')).toContain('var(--qrbit-border-strong)')
  })

  it('states the radius scale as documented', () => {
    for (const name of ['xs', 'sm', 'md', 'lg', 'full'] as const) {
      expect(declaredIn(rootBlock(), `qrbit-radius-${name}`), `--qrbit-radius-${name}`).toBe(
        designScalar('rounded', name),
      )
    }
  })

  it('states the spacing scale as documented', () => {
    for (const name of ['xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'huge'] as const) {
      expect(declaredIn(rootBlock(), `qrbit-space-${name}`), `--qrbit-space-${name}`).toBe(
        designScalar('spacing', name),
      )
    }
  })

  it('makes each of the seven type roles one token, tracking and all', () => {
    for (const role of ROLES) {
      const documented = designRole(role)
      const family = documented['fontFamily']
      const size = documented['fontSize']
      const weight = documented['fontWeight']
      const lineHeight = documented['lineHeight']
      const tracking = documented['letterSpacing']

      // The `font` shorthand order is weight size/line-height family, so a role cannot
      // half-apply and leave a stray line-height behind.
      const declared = declaredIn(rootBlock(), `qrbit-text-${role}`)
      expect(declared, `--qrbit-text-${role}`).toBe(`${weight} ${size}/${lineHeight} var(${
        family === designRole('data')['fontFamily'] ? '--qrbit-font-mono' : '--qrbit-font-ui'
      })`)
      expect(declaredIn(rootBlock(), `qrbit-text-${role}-tracking`), `tracking of ${role}`).toBe(
        tracking,
      )
      // And the same role as a class, because that is how a component takes all four axes
      // in one name.
      expect(cssSource).toContain(`.qrbit-text-${role} {`)
    }
  })

  it('references no token it does not define, and reaches no origin it does not own', () => {
    const used = new Set(
      [...cssSource.matchAll(/var\(--(qrbit-[a-z0-9-]+)/g)].map((match) => match[1] ?? ''),
    )
    const declared = new Set(
      [...cssSource.matchAll(/^\s*--(qrbit-[a-z0-9-]+):/gm)].map((match) => match[1] ?? ''),
    )
    expect([...used].filter((name) => !declared.has(name))).toEqual([])
    expect(declared.size).toBeGreaterThanOrEqual(18)

    // CSP: `style-src 'self'` and `font-src 'self'` in dist/_headers, so no @import of a
    // remote sheet and no network origin anywhere in the layer. Checked against the code,
    // not the comments, which discuss the very thing they forbid.
    expect(cssCode).not.toMatch(/@import\s+url\(/)
    expect(cssCode).not.toMatch(/url\(\s*['"]?(https?:)?\/\//)
    expect(themeCode).not.toMatch(/https?:\/\//)
  })

  it('faces the two self-hosted variable fonts that index.html preloads', () => {
    expect(cssSource).toContain("src: url('/fonts/plus-jakarta-sans-latin.woff2') format('woff2')")
    expect(cssSource).toContain("src: url('/fonts/jetbrains-mono-latin.woff2') format('woff2')")
    expect(cssSource).toMatch(/Plus Jakarta Sans[\s\S]{0,220}font-weight: 400 800/)
    expect(cssSource).toMatch(/JetBrains Mono[\s\S]{0,220}font-weight: 400 700/)
    expect(cssSource.match(/font-display: swap/g)?.length).toBe(2)
    // DESIGN.md: "Third family: removed." Nothing may *declare* a third stack.
    expect(cssCode).not.toMatch(/font-family:[^;]*Space Grotesk/i)
    expect(themeCode).not.toMatch(/Space Grotesk/i)
  })
})

describe('theme.ts agrees with DESIGN.md', () => {
  it('resolves the primary colour to the one accent, and its pressed state', () => {
    expect(merged.primaryColor).toBe('signal')
    expect(merged.primaryShade).toBe(6)
    const signal = ramp('signal')
    expect(hex(signal[6] ?? '')).toBe(hex(designScalar('colors', 'signal')))
    expect(hex(signal[7] ?? '')).toBe(hex(designScalar('colors', 'signal-deep')))
    // `variant="light"` fills resolve to shade 0, which is where signal-subtle lives.
    expect(hex(signal[0] ?? '')).toBe(hex(designScalar('colors', 'signal-subtle')))
  })

  it('names the four status colours and puts the documented hex at the shade components use', () => {
    expect(Object.keys(merged.colors)).toEqual(
      expect.arrayContaining(['signal', 'success', 'warning', 'danger', 'locked', 'dark', 'gray']),
    )
    for (const name of STATUSES) {
      expect(hex(ramp(name)[6] ?? ''), `colors.${name}[6]`).toBe(
        hex(designScalar('colors', name)),
      )
    }
    // The stealth-world palette is gone: no emerald accent, no teal telemetry, and the
    // obsidian neutrals are DESIGN.md's, not Mantine's defaults.
    expect(Object.keys(merged.colors)).not.toContain('emerald')
    expect(Object.keys(merged.colors)).not.toContain('telemetry')
    expect(Object.keys(merged.colors)).not.toContain('shield')
    expect(themeCode).not.toMatch(/#4ade80|#2dd4bf|#0d9488|#0f766e|#a6a7ab|#909296/i)
  })

  it('builds the neutral ramps out of DESIGN.md surfaces instead of Mantine defaults', () => {
    const dark = ramp('dark')
    expect(hex(dark[0] ?? '')).toBe(hex(designScalar('colors', 'dark-ink')))
    expect(hex(dark[6] ?? '')).toBe(hex(designScalar('colors', 'dark-raised')))
    expect(hex(dark[7] ?? '')).toBe(hex(designScalar('colors', 'dark-canvas')))
    expect(hex(dark[8] ?? '')).toBe(hex(designScalar('colors', 'dark-sunken')))
    expect(hex(dark[4] ?? '')).toBe(hex(designScalar('colors', 'dark-border')))

    const gray = ramp('gray')
    expect(hex(gray[0] ?? '')).toBe(hex(designScalar('colors', 'light-canvas')))
    expect(hex(gray[3] ?? '')).toBe(hex(designScalar('colors', 'light-border')))
    expect(hex(gray[4] ?? '')).toBe(hex(designScalar('colors', 'light-border-strong')))
    expect(hex(gray[6] ?? '')).toBe(hex(designScalar('colors', 'light-ink-secondary')))
    expect(hex(gray[8] ?? '')).toBe(hex(designScalar('colors', 'light-ink')))
  })

  it('uses the two self-hosted families, and the heading role weights from DESIGN.md', () => {
    expect(merged.fontFamily).toContain("Plus Jakarta Sans")
    expect(merged.fontFamilyMonospace).toContain("JetBrains Mono")
    expect(merged.headings.fontFamily).toContain('Plus Jakarta Sans')
    for (const [index, role] of ([
      ['h1', 'display'],
      ['h2', 'headline'],
      ['h3', 'title'],
    ] as const)) {
      const documented = designRole(role)
      const heading = merged.headings.sizes[index]
      expect(heading.fontSize, `${index} size`).toBe(documented['fontSize'])
      expect(heading.fontWeight, `${index} weight`).toBe(documented['fontWeight'])
      expect(heading.lineHeight, `${index} line-height`).toBe(documented['lineHeight'])
    }
  })

  it('answers the sm/md/lg radius story and the two-shadow story', () => {
    expect(merged.defaultRadius).toBe('sm')
    expect(merged.radius.sm).toBe(designScalar('rounded', 'sm'))
    expect(merged.radius.md).toBe(designScalar('rounded', 'md'))
    expect(merged.radius.lg).toBe(designScalar('rounded', 'lg'))
    // DESIGN.md's fifth step has no Mantine name, so `radius="full"` is added as one.
    expect(merged.radius.full).toBe(designScalar('rounded', 'full'))
    // Controls 5 / containers 10 / floating menus 7, and `xl` cannot escape the scale.
    expect(merged.components['Button']?.defaultProps?.radius).toBe('sm')
    expect(merged.components['Paper']?.defaultProps?.radius).toBe('lg')
    expect(merged.components['Modal']?.defaultProps?.radius).toBe('md')
    expect(merged.radius.xl).toBe(merged.radius.lg)

    // Two shadows for the whole product, byte-identical to the CSS tokens.
    expect(merged.shadows.sm).toBe(declaredIn(rootBlock(), 'qrbit-shadow-lift'))
    expect(merged.shadows.xs).toBe(declaredIn(rootBlock(), 'qrbit-shadow-lift'))
    expect(merged.shadows.xl).toBe(declaredIn(rootBlock(), 'qrbit-shadow-sheet'))
    expect(merged.shadows.md).toBe(declaredIn(rootBlock(), 'qrbit-shadow-sheet'))
    expect(merged.shadows.lg).toBe(declaredIn(rootBlock(), 'qrbit-shadow-sheet'))
  })

  it('points Mantine semantic slots at the CSS tokens rather than restating them', () => {
    const resolved = qrbitCssVariablesResolver(merged)
    const expected: Record<string, string> = {
      '--mantine-color-body': 'var(--qrbit-canvas)',
      '--mantine-color-text': 'var(--qrbit-ink)',
      '--mantine-color-default': 'var(--qrbit-raised)',
      '--mantine-color-default-border': 'var(--qrbit-border-strong)',
      '--mantine-color-dimmed': 'var(--qrbit-ink-secondary)',
      '--mantine-color-placeholder': 'var(--qrbit-ink-muted)',
      '--mantine-color-error': 'var(--qrbit-danger)',
      '--mantine-color-success': 'var(--qrbit-success)',
    }

    const light = slotsOf(resolved.light)
    const dark = slotsOf(resolved.dark)

    // `defaultRadius: 'sm'` is the "controls are 5px" story, and it is what every
    // component that never names a radius actually resolves to.
    expect(slotsOf(resolved.variables).get('--mantine-radius-default')).toBe('5px')

    for (const [slot, value] of Object.entries(expected)) {
      expect(light.get(slot), `${slot} (light)`).toBe(value)
      expect(dark.get(slot), `${slot} (dark)`).toBe(value)
    }

    // Two slots are scheme-specific on purpose: a hover on paper darkens while a hover on
    // near-black lightens.
    expect(light.get('--mantine-color-default-hover')).toBe('var(--qrbit-sunken)')
    expect(dark.get('--mantine-color-default-hover')).toBe('var(--qrbit-selected)')

    // The shadow names ride the same bridge, which is the only way a `<Modal shadow="xl">`
    // can honour DESIGN.md's rule that dark conveys depth with hairlines, not shadows: the
    // theme's `shadows` scale has no dark counterpart, but `--qrbit-shadow-sheet` does.
    expect(light.get('--mantine-shadow-sm')).toBe('var(--qrbit-shadow-lift)')
    expect(dark.get('--mantine-shadow-sm')).toBe('var(--qrbit-shadow-lift)')
    expect(light.get('--mantine-shadow-xl')).toBe('var(--qrbit-shadow-sheet)')
    expect(dark.get('--mantine-shadow-xl')).toBe('var(--qrbit-shadow-sheet)')

    // The other one: DESIGN.md's `dark-link`, which is a palette value rather than one of
    // the 18 tokens, so it has no `--qrbit-*` name and styles.css reads it back through
    // this variable instead of inventing one.
    expect(hex(dark.get('--mantine-color-anchor') ?? '')).toBe(
      hex(designScalar('colors', 'dark-link')),
    )
    expect(light.get('--mantine-color-anchor')).toBe('var(--qrbit-signal)')
  })
})

describe('the scheme preference store', () => {
  it('is one namespaced key, because session data may not be stored at all', () => {
    expect(THEME_STORAGE_KEY).toBe('qrbit:theme')
    expect(themeCode).toContain('localStorageColorSchemeManager({')
    expect(themeCode).toContain('key: THEME_STORAGE_KEY')
  })
})
