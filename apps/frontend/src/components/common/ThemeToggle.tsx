import { ActionIcon, Tooltip, useMantineColorScheme } from '@mantine/core'
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react'
import type { ReactElement } from 'react'
import type { ThemePreference } from '../../theme'

/**
 * The three states DESIGN.md allows, and the order this control walks them in:
 * light → dark → system → light. There is no separate "clear the preference" step because
 * arriving back at System already is that step, and a fourth state a keyboard user cannot
 * see would be a trap rather than a feature.
 */
const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'auto',
  auto: 'light',
}

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  auto: 'System',
}

/** `'auto'` is the stored value; "System" is the word a person reads. */
const PREFERENCE_ICON: Record<ThemePreference, typeof IconSun> = {
  light: IconSun,
  dark: IconMoon,
  auto: IconDeviceDesktop,
}

const LABEL = 'Color scheme'

/**
 * Light / dark / system, in one icon-only control.
 *
 * It writes Mantine's colour scheme and nothing else — no attribute, no storage call of its
 * own. `themeColorSchemeManager` (theme.ts) persists the value under `qrbit:theme`, and the
 * single `useThemeSchemeAttribute()` mirror mounted in `main.tsx` copies the resolved scheme
 * onto `<html data-theme>`, which is what makes every `--qrbit-*` token change. The control
 * is therefore inert in a tree with no provider (SSR, or a component mounted bare in a
 * test), and two copies on one screen — Settings and the header — cannot disagree.
 *
 * Keyboard operable by construction: `ActionIcon` renders a `type="button"` element, so
 * Enter and Space activate it and the global `:focus-visible` ring (2px `--qrbit-signal`,
 * offset 2px) shows where focus is.
 */
export function ThemeToggle(): ReactElement {
  const { colorScheme, setColorScheme } = useMantineColorScheme()
  const current: ThemePreference = colorScheme
  const next = NEXT_PREFERENCE[current]
  const Icon = PREFERENCE_ICON[current]

  /*
   * Names the current state *and* the action of the next press: the icon alone says which
   * scheme is on, and DESIGN.md requires a control's label to state what it does.
   */
  const description = `${LABEL}: ${PREFERENCE_LABEL[current]}. Switch to ${PREFERENCE_LABEL[next]}.`

  return (
    <Tooltip label={description} withArrow>
      <ActionIcon
        className="tactile-btn"
        // DESIGN.md's icon-only row: quiet fill, ink-secondary, 32px box. Mantine's
        // ActionIcon steps are 28 / 34 / 44, so `lg` (34px) is the nearest step to 32 —
        // which is why the control height is not itself a token (see theme.ts).
        variant="subtle"
        size="lg"
        aria-label={description}
        style={{ transition: 'color 150ms ease, background-color 150ms ease' }}
        onClick={() => setColorScheme(next)}
      >
        <Icon size={18} stroke={1.6} aria-hidden />
      </ActionIcon>
    </Tooltip>
  )
}
