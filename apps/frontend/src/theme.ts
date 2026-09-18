import { createTheme, type MantineColorsTuple } from '@mantine/core'

/**
 * QRDrop Sleek Minimalist Theme
 *
 * Dark-first, stealth utility register:
 * - High-contrast obsidian backgrounds (#0a0b0e, #111317, #181a1f)
 * - Cryptographic emerald accent (#4ade80) for active connections and positive verification
 * - System typography with monospace telemetry/code accents
 * - Tactile, softened borders (radius="md", subtle rgba border)
 */

const emeraldScale: MantineColorsTuple = [
  '#ebfef2',
  '#d3fbe2',
  '#a5f6c4',
  '#74f0a4',
  '#4ade80',
  '#28c465',
  '#1aa651',
  '#13833f',
  '#0f6832',
  '#0b5528',
]

const darkScale: MantineColorsTuple = [
  '#c1c2c5',
  '#a6a7ab',
  '#909296',
  '#5c5f66',
  '#373a40',
  '#2c2e33',
  '#25262b',
  '#1a1b1e',
  '#141517',
  '#0d0e11',
]

export const theme = createTheme({
  primaryColor: 'emerald',
  primaryShade: 4,
  colors: {
    emerald: emeraldScale,
    dark: darkScale,
  },
  defaultRadius: 'md',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  headings: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: '600',
  },
  cursorType: 'pointer',
  components: {
    Button: {
      defaultProps: {
        radius: 'md',
      },
    },
    Modal: {
      defaultProps: {
        radius: 'md',
        overlayProps: {
          backgroundOpacity: 0.65,
          blur: 4,
        },
      },
    },
    Paper: {
      defaultProps: {
        radius: 'md',
      },
    },
    Card: {
      defaultProps: {
        radius: 'md',
      },
    },
  },
})
