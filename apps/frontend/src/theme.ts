import { useEffect } from 'react'
import {
  createTheme,
  defaultCssVariablesResolver,
  isMantineColorScheme,
  localStorageColorSchemeManager,
  useComputedColorScheme,
  type CSSVariablesResolver,
  type MantineColorSchemeManager,
  type MantineColorsTuple,
} from '@mantine/core'

/**
 * QRBit design system — the Mantine half of the token layer.
 *
 * `DESIGN.md` at the repository root is normative: "Light by default, dark by preference,
 * decided once at `:root` — never per component", one accent (#1D4ED8), four status hues
 * that only ever mean their own name, Plus Jakarta Sans doing every job with JetBrains
 * Mono reserved for data, controls at 5px and containers at 10px, two shadows in the whole
 * product. The hexes below are those values, not a palette invented alongside them;
 * `theme.test.ts` fails if either file drifts from the document.
 *
 * There is no dark-first world here any more, and no emerald: the previous revision of
 * this file declared obsidian backgrounds and an emerald accent that no screen implemented.
 * If a surface looks dark it is because `[data-theme='dark']` asked for #0E1420.
 *
 * ## The `--qrbit-*` / Mantine bridge, in the direction that is honest
 *
 * `styles.css` owns the tokens; this file owns the numbers Mantine needs as *colours*.
 * Whether a slot can be bridged by reference depends on who consumes it:
 *
 *  - **Semantic slots can read CSS variables.** `--mantine-color-body`, `-text`,
 *    `-default`, `-dimmed`, `-placeholder`, `-error`, `-success`, `-anchor` and
 *    `--mantine-shadow-*` are emitted as CSS custom properties and are only ever used by
 *    CSS. `qrbitCssVariablesResolver` below points them at `var(--qrbit-*)`, so styles.css
 *    is the single definition and Mantine's surfaces, text and elevation follow the scheme
 *    with no second list of values.
 *  - **Colour ramps cannot.** Every `theme.colors` entry is parsed in JavaScript
 *    (`isLightColor` decides label colour and auto-contrast, `variantColorsResolver`
 *    decides what a filled or light button paints). A `var(--qrbit-signal)` there would be
 *    measured as an invalid colour and Mantine would pick the wrong text on top of it. So
 *    the ramps below are literal hexes taken verbatim from DESIGN.md and pinned to the
 *    `--qrbit-*` tokens by `theme.test.ts` — the agreement is asserted, not hoped for.
 *  - **What the theme object cannot hold stays in CSS**, and the list is repeated at the
 *    foot of this file next to the code that had to work around it: the seven type roles
 *    and their tracking (`HeadingStyle` carries size/weight/line-height but no
 *    `letterSpacing`), the 24px display size (`fontSizes` names stop at `xl`), DESIGN.md's
 *    control heights, and the dark scheme's substitution of hairlines for shadows
 *    (`theme.shadows` has no dark counterpart, which is why `--mantine-shadow-*` is
 *    re-pointed at `--qrbit-shadow-*` per scheme rather than being left to the scale).
 */

/* ------------------------------------------------------------------ scheme -- */

/**
 * Namespaced because AGENTS.md forbids putting *session* data in localStorage; a UI
 * preference is the only thing allowed here, and this key holds nothing else. Mantine's
 * own manager is reused so the stored value and the rendered scheme cannot be two facts.
 */
export const THEME_STORAGE_KEY = 'qrbit:theme'

/** The three states of the toggle: 'auto' is DESIGN.md's "system preference". */
export type ThemePreference = 'light' | 'dark' | 'auto'

/** A concrete scheme: what `[data-theme]` and `data-mantine-color-scheme` both carry. */
export type ThemeScheme = 'light' | 'dark'

export const themeColorSchemeManager: MantineColorSchemeManager = localStorageColorSchemeManager({
  key: THEME_STORAGE_KEY,
})

function prefersDarkScheme(): boolean {
  if (typeof window === 'undefined' || !('matchMedia' in window)) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches === true
}

/**
 * Reads the stored preference. Anything that is not one of the three valid values — no
 * entry, `null`, or a value written by an older build — resolves to 'auto' rather than
 * throwing, so a corrupt store falls back to the system instead of breaking first paint.
 * (Pinned by `ThemeToggle.test.tsx`, which mounts with `qrbit:theme` set to nonsense.)
 */
function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'auto'
  try {
    const stored: unknown = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isMantineColorScheme(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

function resolveThemeScheme(
  preference: ThemePreference,
  dark = prefersDarkScheme(),
): ThemeScheme {
  return preference === 'auto' ? (dark ? 'dark' : 'light') : preference
}

/** Writes the attribute that makes every `--qrbit-*` token in styles.css switch scheme. */
export function applyThemeScheme(scheme: ThemeScheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', scheme)
}

/**
 * Resolves the stored preference once without React, for the frame before the first mount
 * effect. `main.tsx` calls this so a dark-preference visitor never sees a light flash.
 */
export function initialThemeScheme(): ThemeScheme {
  return resolveThemeScheme(readThemePreference())
}

/**
 * Keeps `document.documentElement[data-theme]` equal to Mantine's resolved colour scheme.
 * Mantine owns the state (it stores it, subscribes to `storage`, and listens for
 * `prefers-color-scheme` changes); this is the one mirror, so the two attributes cannot
 * disagree, and no component reads or writes the attribute itself. Mounted once by
 * `main.tsx`; a test or a story that mounts Mantine components in isolation can mount it
 * the same way (see `ThemeToggle.test.tsx`).
 */
export function useThemeSchemeAttribute(): void {
  const scheme = useComputedColorScheme('light', { getInitialValueInEffect: false })
  useEffect(() => {
    applyThemeScheme(scheme)
  }, [scheme])
}

/* ------------------------------------------------------------------ colours -- */

/**
 * DESIGN.md's ramp for the one accent. Index 6 is #1D4ED8 and index 7 is #1E40AF — that is
 * "Signal" and "the pressed state of Signal and nothing else" — and `primaryShade: 6` below
 * is what makes `<Button color="signal">` land on them. Index 0 is #E8EEFC, DESIGN.md's
 * `signal-subtle`, because Mantine resolves `variant="light"` fills to shade 0 in the light
 * scheme: the quiet fill is then the documented tint rather than a fifth blue.
 */
const signalRamp: MantineColorsTuple = [
  '#e8eefc', // signal-subtle: selected rows, light fills
  '#dbeafe',
  '#bfdbfe',
  '#93c5fd',
  '#60a5fa',
  '#3b82f6',
  '#1d4ed8', // signal: the only affirmative action
  '#1e40af', // signal-deep: pressed
  '#1e3a8a',
  '#172554',
]

/**
 * Mantine's colour API needs ten stops for any name it can resolve, but DESIGN.md names
 * exactly one hex per status. Stops 0-5 are that hex mixed toward white and 7-9 toward
 * black, so the ramp is a consequence of the token instead of nine more colours to keep in
 * sync — only index 6 is load-bearing, because `primaryShade` is 6 and that is what
 * `color="danger"` paints. `theme.test.ts` pins index 6 to DESIGN.md for each of them.
 */
function mixToward(hex: string, target: number, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number): string => {
    const source = (value >> shift) & 0xff
    return Math.round(source + (target - source) * amount)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

function statusRamp(base: string): MantineColorsTuple {
  const tint = (amount: number): string => mixToward(base, 0xff, amount)
  const shade = (amount: number): string => mixToward(base, 0x00, amount)
  return [
    tint(0.94),
    tint(0.86),
    tint(0.72),
    tint(0.55),
    tint(0.32),
    tint(0.12),
    base,
    shade(0.14),
    shade(0.28),
    shade(0.42),
  ]
}

/**
 * DESIGN.md's dark neutrals, ordered as Mantine expects (0 lightest → 9 darkest). The
 * ordering is not cosmetic: Mantine's own internals read `dark-0` for text, `dark-7` for the
 * page, `dark-6` for a default control's fill, `dark-5` for its hover and `dark-4` for its
 * border — which lands on ink, canvas, raised, selected and border. The previous revision of
 * this file copied Mantine's default grey-black ramp (#a6a7ab, #909296, #0d0e11) wholesale,
 * and that is where the dark-world leftovers came from.
 */
const darkRamp: MantineColorsTuple = [
  '#e9eef6', // ink
  '#b4c0d0', // ink-secondary
  '#8fa0b4', // ink-muted
  '#5f7391', // border-strong
  '#26313f', // border
  '#1d2a3d', // selected
  '#171f2c', // raised
  '#0e1420', // canvas
  '#0a1017', // sunken
  '#060a0f',
]

/** The same argument for the light scheme: `gray-6` is `dimmed`, `gray-4` a control's border. */
const grayRamp: MantineColorsTuple = [
  '#f4f6f9', // canvas
  '#eaeef4', // sunken
  '#e8eefc', // selected
  '#dde3eb', // border
  '#78889c', // border-strong
  '#5c6b82', // ink-muted
  '#44546a', // ink-secondary
  '#2a3648',
  '#0b1220', // ink
  '#060a12',
]

/* --------------------------------------------------------------- elevation -- */

/** DESIGN.md's entire shadow vocabulary. Two values, used as both theme tokens and CSS. */
const shadowSheet = '0 1px 2px rgba(11, 18, 32, 0.06), 0 8px 24px -8px rgba(11, 18, 32, 0.14)'
const shadowLift = '0 1px 3px rgba(11, 18, 32, 0.1)'

/* -------------------------------------------------------------------- type -- */

const uiFont =
  "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const monoFont =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

/**
 * The seven roles, expressed as far as Mantine can go. `headings.sizes` is the only place a
 * role's size, line-height and weight can be named together, and the scale is then closed:
 * h4/h5/h6 take body, body-secondary and label rather than Mantine's off-scale 18/16/14.
 * Tracking is not in `HeadingStyle`, so the negative tracking on display/headline/title
 * exists only in styles.css — use `<Title>` for the numbers and `.qrbit-text-*` when the
 * tracking matters.
 */
const headingSizes = {
  h1: { fontSize: '24px', fontWeight: '700', lineHeight: '1.2' },
  h2: { fontSize: '18px', fontWeight: '650', lineHeight: '1.3' },
  h3: { fontSize: '15px', fontWeight: '600', lineHeight: '1.35' },
  h4: { fontSize: '14px', fontWeight: '400', lineHeight: '1.5' },
  h5: { fontSize: '13px', fontWeight: '400', lineHeight: '1.45' },
  h6: { fontSize: '12px', fontWeight: '600', lineHeight: '1.3' },
} as const

/* ------------------------------------------------------------------- theme -- */

export const theme = createTheme({
  primaryColor: 'signal',
  /** Shade 6 of every ramp is the DESIGN.md value, in both schemes. */
  primaryShade: 6,
  colors: {
    signal: signalRamp,
    success: statusRamp('#0e7a5f'),
    warning: statusRamp('#b45309'),
    danger: statusRamp('#b4232a'),
    locked: statusRamp('#9a3412'),
    dark: darkRamp,
    gray: grayRamp,
  },
  /**
   * Controls 5px, containers 10px (DESIGN.md, "The One Radius Family Rule"): `sm` is the
   * default because most of the product is a control, and `Paper`/`Card`/`Panel` step up to
   * `lg` via `components` below. `xl` is deliberately clamped to `lg` — DESIGN.md's scale
   * stops at `lg`, so a stray `radius="xl"` cannot produce off-system geometry. `full` is an
   * extra key so `radius="full"` resolves to the chip/dot radius instead of nothing.
   */
  defaultRadius: 'sm',
  radius: {
    xs: '3px',
    sm: '5px',
    md: '7px',
    lg: '10px',
    xl: '10px',
    full: '999px',
  },
  /** DESIGN.md's spacing scale. `xxs`/`xxl`/`huge` are reachable as names, 48px only as a number. */
  spacing: {
    xxs: '2px',
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    xxl: '32px',
    huge: '48px',
  },
  /** The role sizes Mantine can name: label, body-secondary, body, title, headline. */
  fontSizes: {
    xs: '12px',
    sm: '13px',
    md: '14px',
    lg: '15px',
    xl: '18px',
  },
  /**
   * Two shadows for a whole product is a system. Mantine's five names are all answered so
   * no component can ask for a third: anything small is the hover lift, anything that floats
   * above the page is the sheet.
   */
  shadows: {
    xs: shadowLift,
    sm: shadowLift,
    md: shadowSheet,
    lg: shadowSheet,
    xl: shadowSheet,
  },
  fontFamily: uiFont,
  fontFamilyMonospace: monoFont,
  headings: {
    fontFamily: uiFont,
    fontWeight: '700',
    textWrap: 'balance',
    sizes: headingSizes,
  },
  cursorType: 'pointer',
  components: {
    /** Radius by role, not by component default: controls `sm`, floating `md`, panels `lg`. */
    Button: { defaultProps: { radius: 'sm' } },
    ActionIcon: { defaultProps: { radius: 'sm' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Card: { defaultProps: { radius: 'lg' } },
    Modal: {
      defaultProps: {
        radius: 'md',
        shadow: 'xl',
        overlayProps: { backgroundOpacity: 0.65 },
      },
    },
    Popover: { defaultProps: { radius: 'md' } },
    Menu: { defaultProps: { radius: 'md' } },
  },
})

/**
 * The reference half of the bridge: Mantine's semantic slots point at the tokens
 * styles.css already defines, so a surface's colour is written down once.
 *
 * Identical in both blocks on purpose. `--qrbit-*` already flip under `[data-theme]`, so
 * the value a slot resolves to changes with the scheme, and copying a different literal
 * into the `dark` block would be a second source of truth that could disagree with the
 * attribute driving it. Two exceptions, both scheme-specific by design:
 *  - `default-hover` differs because a hover on paper should darken while a hover on
 *    near-black should lighten (which is why it is not in the shared block);
 *  - `anchor` differs because DESIGN.md ships `dark-link` (#93B4FF): #1D4ED8 on #0E1420 is
 *    3.4:1 and unreadable as text. That value is a palette entry, not one of the 18
 *    component tokens, so it is not promoted to a `--qrbit-*` name — styles.css's `a` rule
 *    reads this slot back instead.
 */
export const qrbitCssVariablesResolver: CSSVariablesResolver = (mantineTheme) => {
  const resolved = defaultCssVariablesResolver(mantineTheme)

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
    /*
     * The shadow names too, which is the only way a `<Modal shadow="xl">` can follow the
     * scheme: `theme.shadows` is one scale with no dark counterpart, and DESIGN.md wants a
     * hairline where the light scheme wants a sheet. Mantine emits the theme's scale in the
     * shared `:root, :host` block; these sit in the per-scheme blocks, which are more
     * specific, so Mantine's floating surfaces end up reading whatever `--qrbit-shadow-*`
     * currently means in this scheme.
     */
    '--mantine-shadow-xs': 'var(--qrbit-shadow-lift)',
    '--mantine-shadow-sm': 'var(--qrbit-shadow-lift)',
    '--mantine-shadow-md': 'var(--qrbit-shadow-sheet)',
    '--mantine-shadow-lg': 'var(--qrbit-shadow-sheet)',
    '--mantine-shadow-xl': 'var(--qrbit-shadow-sheet)',
  }

  Object.assign(resolved.light, shared, {
    '--mantine-color-default-hover': 'var(--qrbit-sunken)',
    '--mantine-color-anchor': 'var(--qrbit-signal)',
  })
  Object.assign(resolved.dark, shared, {
    '--mantine-color-default-hover': 'var(--qrbit-selected)',
    '--mantine-color-anchor': '#93b4ff',
  })

  return resolved
}

/*
 * Not expressible through Mantine's theme object, so a component lane must reach these the
 * other way. Recorded here because "we could not do it in the theme" is only useful if it
 * names the substitute:
 *
 *  1. Type roles. `theme.headings.sizes` carries h1–h6 size/weight/line-height (mapped to
 *     display/headline/title above, and to body/body-secondary/label for h4–h6 so no
 *     heading can land off the scale), and `theme.fontSizes` names 12/13/14/15/18 — which
 *     is label, body-secondary, body, title, headline. There is no name for display's 24px
 *     and no `letterSpacing` on a heading at all, so `.qrbit-text-*` and
 *     `--qrbit-text-*` in styles.css carry the roles, and a `<Title order={1}>` gets the
 *     numbers without the −0.02em.
 *  2. Control heights. DESIGN.md's 36px control is Mantine's `size="sm"` exactly, its 32px
 *     small control is between `xs` (30) and `sm` (36), and its 32px icon-only box is not an
 *     `ActionIcon` step at all (28 / 34 / 44). Sizes are component props, not theme slots,
 *     so the ladder is a per-call-site decision for the button lane; `ThemeToggle` documents
 *     the compromise it made.
 *  3. `dark-link` (#93B4FF). A palette value, not one of DESIGN.md's 18 component tokens, so
 *     it is not promoted to a `--qrbit-*` name: it lives in the `anchor` slot above and
 *     styles.css's `a` rule reads that slot back.
 */
