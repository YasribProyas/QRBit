/** @vitest-environment jsdom */
/**
 * Tests for `ThemeToggle` (DESIGN.md: "Light by default, dark by preference, decided once
 * at `:root` — never per component").
 *
 * **What is pinned.** Three things, and they are the three ways this feature can be wrong:
 *   1. the cycle Light → Dark → System → Light, and the value each state writes to
 *      `qrbit:theme` (nothing else may be stored: AGENTS.md forbids session data in
 *      localStorage, so a stray key here is a policy break, not a mess);
 *   2. that `<html data-theme>` — which is what flips every `--qrbit-*` token in
 *      styles.css — tracks Mantine's own resolved scheme after *each* change, and follows
 *      the OS while the preference is System;
 *   3. that a stored value is honoured on mount, and that a value which is not one of the
 *      three (an older build, a hand-edited store) falls back to the system rather than
 *      throwing during first paint.
 *
 * **Why the harness mounts the real provider chain.** The mirror under test is
 * `useThemeSchemeAttribute()` as `main.tsx` mounts it, with `themeColorSchemeManager` and
 * `defaultColorScheme="auto"` as `main.tsx` passes them. `WithMantine` is deliberately not
 * used: it forces `defaultColorScheme="dark"`, which is the stale dark-world default this
 * lane exists to remove, and it omits the scheme manager, so a test through it would
 * exercise a configuration no shipped screen runs with.
 *
 * jsdom runs no CSS engine, so nothing here claims the *colours* change; `theme.test.ts`
 * pins the token values, and this file pins which token set the document is switched into.
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { THEME_STORAGE_KEY, theme, themeColorSchemeManager, useThemeSchemeAttribute } from '../../theme'
import { ThemeToggle } from './ThemeToggle'

let host: HTMLDivElement | null = null
let root: Root | null = null

/** The one mirror `main.tsx` mounts, standing in for `<ThemedApp>` here. */
function SchemeSync() {
  useThemeSchemeAttribute()
  return null
}

/**
 * `env="test"` is Mantine's own switch for disabling transitions and portals, which keeps
 * the tooltip's floating layer out of the way in jsdom.
 */
function mountToggle(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(
      createElement(
        MantineProvider,
        {
          theme,
          colorSchemeManager: themeColorSchemeManager,
          defaultColorScheme: 'auto',
          env: 'test',
        },
        createElement(SchemeSync),
        createElement(ThemeToggle),
      ),
    )
  })

  host = element
  root = created
  return element
}

function toggle(element: HTMLElement): HTMLButtonElement {
  const button = element.querySelector('button[aria-label]')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('test bug: the toggle did not render a labelled button')
  }
  return button
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Both attributes, read from the live document. */
function attributes(): { theme: string | null; mantine: string | null } {
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    mantine: document.documentElement.getAttribute('data-mantine-color-scheme'),
  }
}

function storedPreference(): string | null {
  return window.localStorage.getItem(THEME_STORAGE_KEY)
}

/** Pretends the operating system asked for dark, the way `prefers-color-scheme` would. */
function systemPrefersDark(isDark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isDark && query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-mantine-color-scheme')
  systemPrefersDark(false)
})

afterEach(() => {
  if (root !== null) {
    act(() => {
      root?.unmount()
    })
  }
  host?.remove()
  root = null
  host = null
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-mantine-color-scheme')
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('ThemeToggle (DESIGN.md colour scheme)', () => {
  it('names the current state and the action of the next press', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const element = mountToggle()

    expect(toggle(element).getAttribute('aria-label')).toBe(
      'Color scheme: Light. Switch to Dark.',
    )

    click(toggle(element))
    expect(toggle(element).getAttribute('aria-label')).toBe(
      'Color scheme: Dark. Switch to System.',
    )
  })

  it('cycles Light, Dark, System and writes only the namespaced key', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const element = mountToggle()
    const button = () => toggle(element)

    expect(storedPreference()).toBe('light')

    click(button())
    expect(storedPreference()).toBe('dark')

    click(button())
    expect(storedPreference()).toBe('auto')

    // The cycle closes instead of stopping or clearing: System is the un-picked state.
    click(button())
    expect(storedPreference()).toBe('light')

    expect(window.localStorage.length).toBe(1)
    expect(window.localStorage.key(0)).toBe(THEME_STORAGE_KEY)
  })

  it('keeps <html data-theme> equal to Mantine\'s resolved scheme through the whole cycle', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const element = mountToggle()
    const button = () => toggle(element)

    expect(attributes()).toEqual({ theme: 'light', mantine: 'light' })

    click(button())
    expect(attributes()).toEqual({ theme: 'dark', mantine: 'dark' })

    // System with the OS asking for light resolves to light — and both attributes say so.
    click(button())
    expect(attributes()).toEqual({ theme: 'light', mantine: 'light' })
  })

  it('follows the operating system while the preference is System', () => {
    systemPrefersDark(true)
    const element = mountToggle()

    expect(storedPreference()).toBeNull()
    expect(attributes()).toEqual({ theme: 'dark', mantine: 'dark' })

    // One press moves off System onto the explicit ladder; the OS no longer decides.
    click(toggle(element))
    expect(attributes()).toEqual({ theme: 'light', mantine: 'light' })
    expect(storedPreference()).toBe('light')
  })

  it('honours a stored preference on mount', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const element = mountToggle()

    expect(attributes().theme).toBe('dark')
    expect(toggle(element).getAttribute('aria-label')).toContain('Dark')
  })

  it('falls back to the system for a stored value it cannot read', () => {
    systemPrefersDark(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'cobalt')
    const element = mountToggle()

    // No throw, and the document is in the system scheme rather than a nonsense one.
    expect(attributes()).toEqual({ theme: 'dark', mantine: 'dark' })
    expect(toggle(element).getAttribute('aria-label')).toContain('System')

    click(toggle(element))
    expect(storedPreference()).toBe('light')
    expect(attributes().theme).toBe('light')
  })

  it('stays a labelled button, so it is reachable from the keyboard', () => {
    const element = mountToggle()
    const button = toggle(element)

    expect(button.getAttribute('type')).toBe('button')
    expect(button.textContent).toBe('') // icon only: the aria-label is the whole name
    expect(button.getAttribute('aria-label')).toContain('Switch to')
  })
})
