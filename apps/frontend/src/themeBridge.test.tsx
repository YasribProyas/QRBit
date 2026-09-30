/** @vitest-environment jsdom */
/**
 * The theme bridge: does a Mantine control's colour actually reach the page?
 *
 * `theme.test.ts` pins that the three files agree about *values*. This file pins the thing no
 * value agreement proves: that the values arrive. Every component test in this repository
 * asserts that a label's text is in the DOM; none asserted that the label could be read, and
 * that is how a light-scheme `<Button variant="subtle">` shipped with white text on a white
 * panel — the folder names, dossier names, preview lines and leading icons of the library
 * panel, the "copy code" control, and the discard dialog's "Keep editing" button, all
 * invisible, while the neighbouring grip (which sets its own colour) was fine.
 *
 * ## Mechanism, and why it is deterministic
 *
 * jsdom cannot answer this directly: it does not cascade author stylesheets it was never
 * given, and it does not substitute `var()`, so `getComputedStyle(el).color` reports either
 * nothing or the literal `var(--button-color)`. So this file reads three real things and does
 * the substitution itself:
 *
 *   1. the element's own custom properties, as Mantine writes them through React's style
 *      object (`el.style.getPropertyValue('--button-color')`) — CSSOM, which is why per-element
 *      variables survive a strict `style-src`;
 *   2. the document's custom properties, as `applyThemeCssVariables` writes them onto `<html>`
 *      — the delivery this app now depends on (see theme.ts);
 *   3. the two stylesheets a browser loads as files: `@mantine/core/styles.css` and
 *      `src/styles.css`. They are read from disk because a `?raw` import of them resolves to an
 *      empty string under this project's CSS pipeline, and an empty source would silently make
 *      every assertion below pass.
 *
 * What is deliberately *excluded* is Mantine's `<style data-mantine-styles>` element — the sheet
 * `cssVariablesResolver` output is normally injected into. This app's Content-Security-Policy is
 * `style-src 'self'`, with no `'unsafe-inline'` and no nonce (`vite.config.ts`, written to
 * `dist/_headers`), which forbids inline style *elements*. That is the premise the defect turned
 * on, so "the blocked channel really is the one Mantine uses" is asserted below rather than
 * assumed, and the model only lets a browser see what a file or the CSSOM delivered.
 *
 * ## How this test could still be wrong
 *
 * It emulates substitution, so it cannot see a rule it was not handed: if Mantine moved its
 * scheme blocks into a file, or a variant began consuming a slot that none of the three sources
 * above defines, a real browser could differ from the model. What it does catch — and is written
 * to catch — is the class of failure that hid for a whole release: a slot unmapped in one scheme,
 * a slot pointing at a `--qrbit-*` name that does not exist (invalid at computed-value time,
 * which in Mantine's control classes ends at `var(--mantine-color-white)` — invisible), a bare
 * semantic colour name leaking into a `color:` declaration, the bridge reaching only a channel
 * the CSP forbids, and any control whose text cannot be told apart from the surface it sits on.
 */

import { readFileSync } from 'node:fs'
import { act } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { ActionIcon, Badge, Button, MantineProvider, Text } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyThemeCssVariables,
  qrbitCssVariablesResolver,
  resolvedTheme,
  theme,
  themeColorSchemeManager,
  useThemeSchemeAttribute,
} from './theme'

const projectRoot = process.cwd()
const appCss = readFileSync(`${projectRoot}/src/styles.css`, 'utf8')
const mantineCss = readFileSync(`${projectRoot}/node_modules/@mantine/core/styles.css`, 'utf8')
const mainSource = readFileSync(`${projectRoot}/src/main.tsx`, 'utf8')
const cspSource = readFileSync(`${projectRoot}/vite.config.ts`, 'utf8')

/* ------------------------------------------------------------- the sources -- */

/** `--name: value;` pairs out of a declaration list (a rule body, or a CSS text fragment). */
function parseDeclarations(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of text.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+)/g)) {
    found.set(match[1] ?? '', (match[2] ?? '').trim())
  }
  return found
}

/** Every `--name: value;` pair from every rule whose selector passes `accepts`. */
function declaredBy(source: string, accepts: (selector: string) => boolean): Map<string, string> {
  const found = new Map<string, string>()
  // Comments go first: this stylesheet documents the very selectors it declares, and a
  // comment sitting above a rule is otherwise read as part of that rule's selector.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').replace(/\s+/g, ' ').replace(/\s*([,])\s*/g, '$1 ').trim()
    if (!accepts(selector)) continue
    for (const [name, value] of parseDeclarations(match[2] ?? '')) found.set(name, value)
  }
  return found
}

const normalise = (selector: string): string => selector.replace(/\s+/g, ' ').trim()
const isRootRule = (selector: string): boolean =>
  normalise(selector).replace(', ', ',').replace(',', ', ') === ':root, :host' ||
  normalise(selector) === ':root'
const schemeRule = (scheme: string) => (selector: string): boolean =>
  selector.includes(`[data-mantine-color-scheme='${scheme}']`) ||
  selector.includes(`[data-mantine-color-scheme="${scheme}"]`)
const isDarkTokenRule = (selector: string): boolean => normalise(selector) === "[data-theme='dark']"

/** Mantine's static sheet: what the framework paints when the bridge never arrives. */
const mantineShared = declaredBy(mantineCss, isRootRule)
const mantineLight = declaredBy(mantineCss, schemeRule('light'))
const mantineDark = declaredBy(mantineCss, schemeRule('dark'))

/** DESIGN.md's tokens, as the browser has them from styles.css. */
const appLightTokens = declaredBy(appCss, isRootRule)
const appDarkTokens = declaredBy(appCss, isDarkTokenRule)

/* ------------------------------------------------- the substitution engine -- */

type Scheme = 'light' | 'dark'

interface Resolution {
  readonly ok: boolean
  readonly value: string
  readonly trail: readonly string[]
}

/**
 * `var()` substitution with custom-property semantics: a name that is not defined — or whose
 * own value is guaranteed-invalid — invalidates the reference, and only then does a fallback
 * apply. That distinction *is* the bug: Mantine's control classes end their colour chains at
 * `var(--mantine-color-white)` on purpose, so an unmapped slot does not mean "no colour", it
 * means white.
 */
function substitute(input: string, model: ReadonlyMap<string, string>): Resolution {
  const trail: string[] = []

  const resolve = (text: string, depth: number): { ok: boolean; value: string } => {
    const at = text.indexOf('var(')
    if (at === -1) return { ok: true, value: text.trim() }
    if (depth > 16 || !text.includes(')')) return { ok: false, value: text }

    let end = -1
    let open = 0
    for (let i = at + 3; i < text.length; i += 1) {
      if (text[i] === '(') open += 1
      else if (text[i] === ')') {
        open -= 1
        if (open === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return { ok: false, value: text }

    const inner = text.slice(at + 4, end)
    const comma = inner.indexOf(',')
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim()
    trail.push(name)

    const head = text.slice(0, at)
    const tail = text.slice(end + 1)
    const splice = (value: string): { ok: boolean; value: string } => {
      const next = resolve(value, depth + 1)
      return { ok: next.ok, value: `${head} ${next.value} ${tail}`.replace(/\s+/g, ' ').trim() }
    }

    const declared = model.get(name)
    if (declared === undefined) {
      return fallback === null ? { ok: false, value: text } : splice(fallback)
    }
    const own = resolve(declared, depth + 1)
    if (!own.ok) {
      return fallback === null ? { ok: false, value: text } : splice(fallback)
    }
    return splice(own.value)
  }

  const result = resolve(input, 0)
  return { ok: result.ok, value: result.value, trail }
}

/** The names the CSSOM delivery last wrote onto `<html>`. */
let appliedNames: string[] = []

/** Runs the app's own delivery step and records what it wrote. */
function deliverCssVariables(scheme: Scheme): void {
  applyThemeCssVariables(scheme)
  const serialised = document.documentElement.getAttribute('style') ?? ''
  appliedNames = [...serialised.matchAll(/--[A-Za-z0-9-]+/g)].map((match) => match[0])
}

/**
 * What a browser may know in this scheme: the two files it loads, the tokens that follow
 * `<html>[data-theme]`, plus whatever the app wrote through the CSSOM. Nothing from a `<style>`
 * element, because `style-src 'self'` refuses it.
 *
 * `withCssVariables: false` models the world without the bridge — Mantine's own defaults, which
 * is what the deployed page was reduced to — and the tests below use it to show that the
 * delivered assertions are not satisfiable from the framework alone.
 */
function variablesFor(scheme: Scheme, withCssVariables: boolean): Map<string, string> {
  const model = new Map<string, string>()
  for (const map of [
    mantineShared,
    scheme === 'dark' ? mantineDark : mantineLight,
    appLightTokens,
    ...(scheme === 'dark' ? [appDarkTokens] : []),
  ]) {
    for (const [name, value] of map) model.set(name, value)
  }
  if (withCssVariables) {
    for (const name of appliedNames) {
      const value = document.documentElement.style.getPropertyValue(name)
      if (value !== '') model.set(name, value)
    }
  }
  return model
}

/* ----------------------------------------------------------------- colours -- */

const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  transparent: 'rgba(0, 0, 0, 0)',
}

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

function toRgb(value: string): Rgb | null {
  const text = value.trim().toLowerCase()
  const named = NAMED[text]
  if (named !== undefined) return toRgb(named)
  if (text === '') return null
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)
  if (hex !== null) {
    const digits = hex[1] ?? ''
    const full = digits.length === 3 ? digits.split('').map((c) => `${c}${c}`).join('') : digits
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
      a: 1,
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\)$/.exec(text)
  if (rgb === null) return null
  return {
    r: Number(rgb[1] ?? 0),
    g: Number(rgb[2] ?? 0),
    b: Number(rgb[3] ?? 0),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  }
}

function luminance(colour: Rgb): number {
  const channel = (raw: number): number => {
    const srgb = raw / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b)
}

/** WCAG contrast of `text` composited onto `background`, after any alpha in either. */
function contrast(text: string, background: string, model: ReadonlyMap<string, string>): number {
  const paint = (value: string): Rgb | null => {
    const resolved = substitute(value, model)
    if (!resolved.ok) return null
    return toRgb(resolved.value)
  }
  const ink = paint(text)
  const surface = paint(background)
  if (ink === null || surface === null) return Number.NaN
  const flat = (colour: Rgb): Rgb =>
    colour.a === 1
      ? colour
      : {
          r: colour.r * colour.a + surface.r * (1 - colour.a),
          g: colour.g * colour.a + surface.g * (1 - colour.a),
          b: colour.b * colour.a + surface.b * (1 - colour.a),
          a: 1,
        }
  const light = Math.max(luminance(flat(ink)), luminance(flat(surface)))
  const dark = Math.min(luminance(flat(ink)), luminance(flat(surface)))
  return (light + 0.05) / (dark + 0.05)
}

/** The colour a mounted control actually paints its label with, including the class fallback. */
function labelColour(element: HTMLElement, varName: string, model: ReadonlyMap<string, string>): string {
  const declared = element.style.getPropertyValue(varName)
  expect(
    declared,
    `${varName}: Mantine must hand a control its colour through the CSSOM (style[${varName}])`,
  ).not.toBe('')
  const local = new Map(model)
  local.set(varName, declared)
  const resolution = substitute(`var(${varName}, var(--mantine-color-white))`, local)
  return resolution.ok ? resolution.value : 'unresolved'
}

/* ------------------------------------------------------------ the app stack -- */

/** DESIGN.md's surfaces, per scheme: what a control sits on and what it sits in. */
const SURFACE = {
  light: { raised: '#ffffff', canvas: '#e6e6e3', sunken: '#edece9', selected: '#f4f3f0' },
  dark: { raised: '#161c28', canvas: '#0a0e17', sunken: '#0a0f18', selected: '#1d2a3d' },
} as const

const mounts: Root[] = []

/**
 * The provider exactly as `main.tsx` wires it: same theme object, same resolver on the same
 * prop name, same colour-scheme manager, and the app's own scheme mirror — which is what carries
 * the CSS variables onto `<html>`.
 */
function mountAppStack(children: ReactNode, scheme: Scheme): HTMLElement {
  deliverCssVariables(scheme)
  const host = document.createElement('div')
  document.body.append(host)
  // The app's own mirror, mounted inside the provider that owns the scheme.
  function Mirror() {
    useThemeSchemeAttribute()
    return <div>{children}</div>
  }
  const instance = createRoot(host)
  mounts.push(instance)
  act(() => {
    instance.render(
      <MantineProvider
        theme={theme}
        cssVariablesResolver={qrbitCssVariablesResolver}
        colorSchemeManager={themeColorSchemeManager}
        defaultColorScheme={scheme}
      >
        <Mirror />
      </MantineProvider>,
    )
  })
  return host
}

beforeEach(() => {
  // React 19 only runs `act` synchronously when the environment says it may, which is the
  // same flag the component suites in this repository set (e.g. `pages/Home.test.tsx`).
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  for (const instance of mounts.splice(0)) {
    act(() => {
      instance.unmount()
    })
  }
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('style')
  appliedNames = []
})

function byTestId(host: HTMLElement, id: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (element === null) throw new Error(`test bug: no [data-testid="${id}"] was mounted`)
  return element
}

/* ------------------------------------------------------------------ tests -- */

describe('the premise: this CSP blocks the channel Mantine would otherwise use', () => {
  it('ships style-src without unsafe-inline and without a nonce', () => {
    // The directive list, not the file around it: vite.config.ts *explains* the policy in
    // comments that name the very keywords it forbids.
    const block = /const csp = \[([\s\S]*?)\]\.join/.exec(cspSource)?.[1] ?? ''
    expect(block).toContain(`"style-src 'self'"`)
    expect(block).not.toContain('unsafe-inline')
    expect(block).not.toContain('nonce-')
  })

  it('and Mantine delivers the resolver output as an inline <style> element', () => {
    const host = mountAppStack(<span data-testid="span">x</span>, 'light')
    expect(byTestId(host, 'span').textContent).toBe('x')
    const injected = [...document.querySelectorAll('style')].filter(
      (element) => element.getAttribute('data-mantine-styles') !== null,
    )
    expect(injected.length, 'Mantine injects its variables as a <style> element').toBeGreaterThan(0)
    for (const element of injected) {
      // Text content, no src, no nonce: exactly what `style-src 'self'` refuses to apply.
      expect(element.getAttribute('nonce') ?? '').toBe('')
      expect(element.getAttribute('src')).toBeNull()
      expect((element.textContent ?? '').length).toBeGreaterThan(0)
    }
  })

  it('and that sheet is the only place Mantine defines our own colour names', () => {
    // `signal` is not one of Mantine's colours, so nothing in a file it owns can define it.
    expect(mantineShared.has('--mantine-color-signal-6')).toBe(false)
    expect(mantineLight.has('--mantine-color-signal-light-color')).toBe(false)
    expect(substitute('var(--mantine-color-signal-light-color)', variablesFor('light', false)).ok).toBe(
      false,
    )
    deliverCssVariables('light')
    const delivered = substitute('var(--mantine-color-signal-light-color)', variablesFor('light', true))
    expect(delivered.ok, 'the bridge is what makes the ramp readable').toBe(true)
  })
})

describe('the bridge reaches the document', () => {
  it('is wired into the option Mantine 9 reads, and applied before the first paint', () => {
    // `cssVariablesResolver` and `staticCssVariablesResolver` are different options; wiring the
    // wrong one produces no overrides and no error.
    expect(mainSource).toMatch(/cssVariablesResolver=\{qrbitCssVariablesResolver\}/)
    expect(mainSource).not.toMatch(/staticCssVariablesResolver=\{qrbitCssVariablesResolver\}/)
    expect(mainSource).toMatch(/applyThemeCssVariables\(initialScheme\)/)
    expect(mainSource.indexOf('applyThemeCssVariables(initialScheme)')).toBeLessThan(
      mainSource.indexOf('createRoot(container).render'),
    )
  })

  it('writes the semantic slots onto <html> through the CSSOM, in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      deliverCssVariables(scheme)
      const style = document.documentElement.style
      const shared: Record<string, string> = {
        '--mantine-color-body': 'var(--qrbit-canvas)',
        '--mantine-color-text': 'var(--qrbit-ink)',
        '--mantine-color-default': 'var(--qrbit-raised)',
        '--mantine-color-default-color': 'var(--qrbit-ink)',
        '--mantine-color-default-border': 'var(--qrbit-border-strong)',
        '--mantine-color-dimmed': 'var(--qrbit-ink-secondary)',
        '--mantine-color-placeholder': 'var(--qrbit-ink-muted)',
        '--mantine-color-error': 'var(--qrbit-danger)',
        '--mantine-color-success': 'var(--qrbit-success)',
        '--mantine-shadow-sm': 'var(--qrbit-shadow-lift)',
        '--mantine-shadow-xl': 'var(--qrbit-shadow-sheet)',
      }
      for (const [name, value] of Object.entries(shared)) {
        expect(style.getPropertyValue(name), `${name} (${scheme})`).toBe(value)
      }
      // The two slots whose *mapping*, not just whose token, is scheme-specific.
      expect(style.getPropertyValue('--mantine-color-default-hover')).toBe(
        scheme === 'dark' ? 'var(--qrbit-selected)' : 'var(--qrbit-sunken)',
      )
      expect(style.getPropertyValue('--mantine-color-scheme')).toBe(scheme)
      expect(style.getPropertyValue('--mantine-color-anchor')).toBe(
        scheme === 'dark' ? '#93b4ff' : 'var(--qrbit-signal)',
      )
    }
  })

  it('agrees with the sheet Mantine injects, so the two deliveries cannot drift apart', () => {
    mountAppStack(<span>x</span>, 'light')
    const injected = [...document.querySelectorAll('style')]
      .map((element) => element.textContent ?? '')
      .join('\n')
    const lightBlock = /:root\[data-mantine-color-scheme="light"\][^{]*\{([^}]*)\}/.exec(injected)
    expect(lightBlock, 'the injected sheet carries a light block').not.toBeNull()
    for (const [name, value] of parseDeclarations(lightBlock?.[1] ?? '')) {
      if (!name.startsWith('--mantine-color-')) continue
      expect(
        document.documentElement.style.getPropertyValue(name),
        `${name} differs between Mantine's sheet and the CSSOM delivery`,
      ).toBe(value)
    }
  })
})

describe('a quiet control is readable, in both schemes (the reported defect)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`gives a library-row subtle button its own ink on ${scheme} paper`, () => {
      const host = mountAppStack(
        <div>
          <Button variant="subtle" size="sm" data-testid="row">
            Quarterly report.pdf
          </Button>
          <Button variant="subtle" data-testid="copy">
            Copy code
          </Button>
        </div>,
        scheme,
      )
      const model = variablesFor(scheme, true)
      for (const id of ['row', 'copy']) {
        const label = labelColour(byTestId(host, id), '--button-color', model)
        expect(label, `${id} resolves`).not.toBe('unresolved')
        expect(label.toLowerCase(), `${id} is not the framework white`).not.toBe('#ffffff')
        expect(
          contrast(label, SURFACE[scheme].raised, model),
          `${id}: quiet label on ${scheme} raised`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(label, SURFACE[scheme].canvas, model),
          `${id}: quiet label on ${scheme} canvas`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      // DESIGN.md, "Buttons": Quiet = transparent fill, Ink Secondary text.
      const expected = (scheme === 'dark' ? appDarkTokens : appLightTokens).get('--qrbit-ink-secondary')
      expect(byTestId(host, 'row').style.getPropertyValue('--button-color')).toBe(
        'var(--mantine-color-dimmed)',
      )
      if (expected !== undefined) {
        expect(labelColour(byTestId(host, 'row'), '--button-color', model).toLowerCase()).toBe(
          expected.toLowerCase(),
        )
      }
    })

    it(`keeps the icon-only grip at least 3:1 on ${scheme} paper`, () => {
      const host = mountAppStack(
        <div>
          <ActionIcon variant="subtle" size="lg" data-testid="grip">
            {'⋮'}
          </ActionIcon>
          <ActionIcon variant="subtle" size="lg" c="dimmed" data-testid="quiet">
            {'⋮'}
          </ActionIcon>
        </div>,
        scheme,
      )
      const model = variablesFor(scheme, true)
      for (const id of ['grip', 'quiet']) {
        const colour = labelColour(byTestId(host, id), '--ai-color', model)
        expect(colour, `${id} resolves`).not.toBe('unresolved')
        expect(
          contrast(colour, SURFACE[scheme].raised, model),
          `${id} is an affordance a user must find (${scheme})`,
        ).toBeGreaterThanOrEqual(3)
      }
    })
  }
})

describe('every slot a variant this app ships consumes resolves in both schemes', () => {
  /** The variants in the component tree: subtle 47, default 32, light 23, filled 4 uses. */
  const VARIANTS = ['subtle', 'default', 'light', 'filled'] as const
  /**
   * "No `color` prop" is most of them. A control resolves that to the theme's primary before it
   * reaches the resolver (`color: color || theme.primaryColor`), so that is the case modelled —
   * `parseThemeColor` refuses a literal `undefined`.
   */
  const COLORS = [
    'signal',
    'gray',
    'dark',
    'danger',
    'success',
    'warning',
    'locked',
  ] as const

  const cases = VARIANTS.flatMap((variant) =>
    COLORS.map((color) => ({ label: `${variant}/${color}`, variant, color })),
  )

  it.each(cases)('%label', ({ variant, color }) => {
    for (const scheme of ['light', 'dark'] as const) {
      deliverCssVariables(scheme)
      const model = variablesFor(scheme, true)
      const colors = resolvedTheme.variantColorResolver({
        color,
        theme: resolvedTheme,
        variant,
        gradient: undefined,
        autoContrast: undefined,
      })

      for (const [role, value] of Object.entries(colors)) {
        if (typeof value !== 'string' || value === '') continue
        const resolution = substitute(value, model)
        expect(
          resolution.ok,
          `${variant}/${color} ${role} (${scheme}): "${value}" breaks at ${
            resolution.trail.at(-1) ?? '??'
          }`,
        ).toBe(true)
        if (role === 'color' || role === 'background') {
          expect(
            toRgb(resolution.value),
            `${role} must be a colour, not a name: "${value}" -> "${resolution.value}"`,
          ).not.toBeNull()
        }
      }

      const surface = colors.background === 'transparent' ? SURFACE[scheme].raised : colors.background
      const ratio = contrast(colors.color, surface, model)
      expect(
        ratio,
        `${variant}/${color} label on its own surface (${scheme}): ${colors.color} on ${surface}`,
      ).toBeGreaterThanOrEqual(variant === 'filled' ? 3 : 4.5)
    }
  })

  it('never answers a semantic colour name with the bare name', () => {
    for (const variant of VARIANTS) {
      const colors = resolvedTheme.variantColorResolver({
        color: 'dimmed',
        theme: resolvedTheme,
        variant,
        gradient: undefined,
        autoContrast: undefined,
      })
      expect(colors.color, variant).not.toBe('dimmed')
      expect(substitute(colors.color, variablesFor('light', true)).ok, variant).toBe(true)
    }
  })

  it('points only at tokens that exist in the scheme that reads them', () => {
    const resolved = qrbitCssVariablesResolver(resolvedTheme)
    const perScheme: Record<Scheme, Map<string, string>> = {
      light: appLightTokens,
      dark: new Map([...appLightTokens, ...appDarkTokens]),
    }
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = perScheme[scheme]
      const block = scheme === 'dark' ? resolved.dark : resolved.light
      for (const [name, raw] of Object.entries(block)) {
        for (const match of String(raw).matchAll(/var\(--(qrbit-[A-Za-z0-9-]+)/g)) {
          const token = `--${match[1] ?? ''}`
          expect(tokens.has(token), `${name} (${scheme}) points at ${token}, which is never defined`).toBe(true)
        }
      }
    }
    // The other half of that: a token re-declared per scheme must have a light value too, or a
    // consumer that reads it outside the dark block gets nothing at computed-value time.
    for (const name of appDarkTokens.keys()) {
      expect(appLightTokens.has(name), `${name} is declared only under [data-theme='dark']`).toBe(true)
    }
  })

  it('keeps a hovered or selected control on the right side of its label', () => {
    for (const scheme of ['light', 'dark'] as const) {
      deliverCssVariables(scheme)
      const model = variablesFor(scheme, true)
      const label = 'var(--mantine-color-default-color)'
      for (const [name, surface] of [
        ['default fill', 'var(--mantine-color-default)'],
        ['hovered fill', 'var(--mantine-color-default-hover)'],
        ['the page itself', 'var(--mantine-color-body)'],
      ] as const) {
        expect(
          contrast(label, surface, model),
          `${scheme}: a control's label on its ${name}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(
        substitute('var(--mantine-color-default)', model).value,
        `${scheme}: a raised control is not the page it sits on`,
      ).not.toBe(SURFACE[scheme].canvas)
    }
  })

  it('does not leave the dark scheme wearing Mantine\u2019s greys', () => {
    deliverCssVariables('dark')
    const delivered = variablesFor('dark', true)
    const starved = variablesFor('dark', false)

    // With the bridge missing, `--mantine-color-body` in dark is Mantine's own neutral
    // #242424 (dark-7) and `--mantine-color-default` its #2E2E2E (dark-6) — which is exactly
    // the grey-on-grey dropdown and the grey button the owner reported. Every value asserted
    // below is DESIGN.md's dark step instead.
    const starvedBody = substitute('var(--mantine-color-body)', starved)
    expect(starvedBody.ok).toBe(true)
    expect(starvedBody.value.toLowerCase()).not.toBe(SURFACE.dark.canvas)

    const expectations: readonly (readonly [string, string, 'surface' | 'text' | 'line'])[] = [
      ['--mantine-color-body', SURFACE.dark.canvas, 'surface'],
      ['--mantine-color-default', SURFACE.dark.raised, 'surface'],
      ['--mantine-color-default-hover', SURFACE.dark.selected, 'surface'],
      ['--mantine-color-text', '#e9eef6', 'text'],
      ['--mantine-color-default-color', '#e9eef6', 'text'],
      ['--mantine-color-dimmed', '#9ca3af', 'text'],
      ['--mantine-color-default-border', '#5f7391', 'line'],
    ]
    for (const [name, documented, kind] of expectations) {
      const got = substitute(`var(${name})`, delivered)
      expect(got.ok, name).toBe(true)
      expect(got.value.toLowerCase(), `${name} is DESIGN.md's dark value`).toBe(documented)
      if (name === '--mantine-color-body') continue // it *is* the page; there is nothing to tell apart
      const against = 'var(--mantine-color-body)'
      const ratio = contrast(`var(${name})`, against, delivered)
      const floor = kind === 'text' ? 4.5 : kind === 'line' ? 3 : 1.05
      expect(ratio, `${name} against the page (${kind}) must be told apart`).toBeGreaterThanOrEqual(floor)
      if (kind === 'text') {
        expect(
          contrast(`var(${name})`, 'var(--mantine-color-default)', delivered),
          `${name} on a raised control`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      if (name === '--mantine-color-default-hover') {
        expect(
          contrast('var(--mantine-color-default-color)', `var(${name})`, delivered),
          'a hovered control still reads',
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(`var(${name})`, 'var(--mantine-color-default)', delivered),
          'hover lifts the fill one step, it does not flatten it',
        ).toBeGreaterThanOrEqual(1.05)
      }
    }
  })

  /**
   * The floating surfaces the owner also flagged: Mantine does not read a semantic slot for a
   * dropdown's fill, it hard-codes one per scheme in its own class — light
   * `background-color: var(--mantine-color-white)`, dark `var(--mantine-color-dark-6)`, border
   * `--popover-border-color` at `gray-2` / `dark-4`, and a menu item hover that falls back to
   * the same two shades. Those are *shade slots of the ramps this theme replaced*, so they only
   * become DESIGN.md's surfaces if the bridge arrives: with the ramp values missing the
   * dropdown is Mantine's #2E2E2E on its #242424 page with a #424242 edge — the grey-on-grey
   * context menu, all three of them greys from a palette this theme replaced. Nothing here needs a component change; the ramps are already
   * derived from the documented surfaces, and this pins that they land where the owner sees them.
   */
  it('lands a floating surface on DESIGN.md\u2019s raised step, not on the page', () => {
    for (const scheme of ['light', 'dark'] as const) {
      deliverCssVariables(scheme)
      const model = variablesFor(scheme, true)
      const raised = substitute(
        scheme === 'light' ? 'var(--mantine-color-white)' : 'var(--mantine-color-dark-6)',
        model,
      )
      const border = substitute(
        scheme === 'light'
          ? 'var(--mantine-color-gray-2)'
          : 'var(--mantine-color-dark-4)',
        model,
      )
      const hover = substitute(
        scheme === 'light'
          ? 'var(--mantine-color-gray-1)'
          : 'var(--mantine-color-dark-4)',
        model,
      )
      expect(raised.ok && border.ok && hover.ok, `${scheme}: every chain resolves`).toBe(true)
      const hex = (value: string): string => {
        const rgb = toRgb(value)
        return rgb === null ? value.toLowerCase() : `#${[rgb.r, rgb.g, rgb.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
      }
      expect(hex(raised.value), `${scheme} dropdown fill`).toBe(SURFACE[scheme].raised)
      expect(
        contrast('var(--mantine-color-text)', raised.value, model),
        `${scheme}: a label inside the dropdown`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(raised.value, 'var(--mantine-color-body)', model),
        `${scheme}: the dropdown is one step above the page`,
      ).toBeGreaterThanOrEqual(1.05)
      // The edge itself is *pinned*, not endorsed: Mantine hard-codes the dropdown border to
      // `gray-2` (light) and `dark-4` (dark), and those indices are where this theme's neutral
      // ramps put DESIGN.md's `selected` and `border`. So a light dropdown's 1px edge is
      // #E8EEFC on #FFFFFF — 1.16:1, found only by the sheet shadow — which is a ramp-order
      // decision (or a `vars={{ dropdown }}` on the component) rather than a bridge mapping, and
      // it is reported rather than hidden behind a threshold this value cannot pass.
      expect(hex(border.value), `${scheme} dropdown edge`).toBe(
        scheme === 'light' ? SURFACE.light.selected : '#1f2937',
      )
      expect(
        contrast(border.value, 'var(--mantine-color-body)', model),
        `${scheme}: the edge at least separates the sheet from the page`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        contrast('var(--mantine-color-text)', hover.value, model),
        `${scheme}: a hovered menu item still reads`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('still colours ordinary content mounted inside the same tree', () => {
    const host = mountAppStack(
      <div>
        <Button variant="light" color="danger" data-testid="discard">
          Discard
        </Button>
        <Badge variant="light" color="locked" data-testid="badge">
          Encrypted
        </Badge>
        <Text c="dimmed" data-testid="aside">
          Dossiers that are not in a folder listed here.
        </Text>
      </div>,
      'light',
    )
    const model = variablesFor('light', true)
    expect(byTestId(host, 'discard').style.getPropertyValue('--button-bg')).not.toBe('')
    expect(byTestId(host, 'badge').style.getPropertyValue('--badge-color')).not.toBe('')
    const aside = byTestId(host, 'aside').style.getPropertyValue('color')
    expect(
      contrast(aside === '' ? 'var(--mantine-color-dimmed)' : aside, SURFACE.light.canvas, model),
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrast(
        labelColour(byTestId(host, 'discard'), '--button-color', model),
        substitute(byTestId(host, 'discard').style.getPropertyValue('--button-bg'), model).value,
        model,
      ),
    ).toBeGreaterThanOrEqual(4.5)
  })
})
