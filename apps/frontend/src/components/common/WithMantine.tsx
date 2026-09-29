import { useContext } from 'react'
import type { ReactNode } from 'react'
import { MantineContext, MantineProvider } from '@mantine/core'
import { theme } from '../../theme'

/**
 * Ensures Mantine components always have a MantineProvider ancestor, even when mounted in
 * isolation in test environments.
 *
 * It must mount the SAME SCHEME the app defaults to. It used to say `defaultColorScheme="dark"`,
 * and that is a large part of why the shipped "white text on a white panel" defect survived
 * 1,175 tests: every isolated component test rendered the dark scheme, so a light-scheme colour
 * failure was simply unobservable here no matter what the component did.
 *
 * `cssVariablesResolver` is deliberately NOT mounted here, even though `main.tsx` uses it. Two
 * reasons, both measured rather than assumed:
 *
 *  - jsdom returns the initial value for `color` on every element and does not substitute
 *    `var()` chains, so mounting the resolver buys zero colour coverage in a component test; and
 *  - Mantine emits the resolver's map as stylesheet text that then shows up inside
 *    `element.textContent`, which breaks the substring assertions this suite depends on. Adding
 *    it made `expect(text).not.toContain('selected')` read the entire variable dump.
 *
 * The map is asserted where it can be read as data instead: `src/themeBridge.test.tsx`.
 */
export function WithMantine({ children }: { children: ReactNode }) {
  const ctx = useContext(MantineContext)
  if (!ctx) {
    return (
      <MantineProvider theme={theme} defaultColorScheme="light">
        {children}
      </MantineProvider>
    )
  }
  return <>{children}</>
}
