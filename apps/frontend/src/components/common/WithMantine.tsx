import { useContext } from 'react'
import type { ReactNode } from 'react'
import { MantineContext, MantineProvider } from '@mantine/core'
import { theme } from '../../theme'

/**
 * Ensures Mantine components always have a MantineProvider ancestor,
 * even when mounted in isolation in test environments.
 */
export function WithMantine({ children }: { children: ReactNode }) {
  const ctx = useContext(MantineContext)
  if (!ctx) {
    return (
      <MantineProvider theme={theme} defaultColorScheme="dark">
        {children}
      </MantineProvider>
    )
  }
  return <>{children}</>
}
