import { createTheme, type MantineColorsTuple } from '@mantine/core'

/**
 * QRBit Sleek Minimalist Theme
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

const signalBlueScale: MantineColorsTuple = [
  '#eff6ff',
  '#dbeafe',
  '#bfdbfe',
  '#93c5fd',
  '#60a5fa',
  '#3b82f6',
  '#1d4ed8',
  '#1e40af',
  '#1e3a8a',
  '#172554',
]

const shieldOrangeScale: MantineColorsTuple = [
  '#fff7ed',
  '#ffedd5',
  '#fed7aa',
  '#fdba74',
  '#fb923c',
  '#f97316',
  '#ea580c',
  '#c2410c',
  '#9a3412',
  '#7c2d12',
]

const telemetryGreenScale: MantineColorsTuple = [
  '#f0fdfa',
  '#ccfbf1',
  '#99f6e4',
  '#5eead4',
  '#2dd4bf',
  '#14b8a6',
  '#0d9488',
  '#0f766e',
  '#115e59',
  '#134e4a',
]

export const theme = createTheme({
  primaryColor: 'signal',
  primaryShade: 6,
  colors: {
    signal: signalBlueScale,
    shield: shieldOrangeScale,
    telemetry: telemetryGreenScale,
    emerald: emeraldScale,
    dark: darkScale,
  },
  defaultRadius: 'md',
  fontFamily:
    "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace:
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  headings: {
    fontFamily:
      "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontWeight: '700',
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
