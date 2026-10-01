---
name: QRBit — Spark Pixel Admin
description: "Scan a QR code. Files appear. No login. No cloud. No trace."
colors:
  signal: "#1D4ED8"
  signal-deep: "#1E40AF"
  signal-subtle: "#E8EEFC"
  success: "#0E8A5F"
  warning: "#E5A016"
  danger: "#D93F3F"
  locked: "#9A3412"
  light-canvas: "#E6E6E3"
  light-raised: "#FFFFFF"
  light-sunken: "#EDECE9"
  light-selected: "#F4F3F0"
  light-ink: "#141414"
  light-ink-secondary: "#5C5C58"
  light-ink-muted: "#8E8E89"
  light-border: "#E4E3DF"
  light-border-strong: "#D6D5D0"
  dark-canvas: "#0A0E17"
  dark-raised: "#161C28"
  dark-sunken: "#0A0F18"
  dark-selected: "#1D2A3D"
  dark-ink: "#E9EEF6"
  dark-ink-secondary: "#9CA3AF"
  dark-ink-muted: "#6B7280"
  dark-border: "#1F2937"
  dark-border-strong: "#5F7391"
  dark-link: "#93B4FF"
  canvas: "#E6E6E3"
  surface: "#FFFFFF"
  surface-muted: "#F4F3F0"
  surface-sunken: "#EDECE9"
  border: "#E4E3DF"
  border-strong: "#D6D5D0"
  divider: "#E9E8E4"
  primary: "#2A2A2A"
  action: "#2A2A2A"
  action-hover: "#141414"
  ink: "#111111"
  neutral-status: "#8E8E89"
  neutral-bg: "#F1F0ED"
  chart-series-primary: "#111111"
  chart-series-secondary: "#DCDCD8"
  chart-cell-empty: "#F0F0EE"
  chart-gridline: "#D9D8D3"
  chart-crosshair: "#141414"
typography:
  display:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.011em"
  title:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body-secondary:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.01em"
  data:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
rounded:
  xs: "3px"
  sm: "5px"
  md: "7px"
  lg: "10px"
  full: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  huge: "48px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.signal}"
    textColor: "#FFFFFF"
  button-primary-active:
    backgroundColor: "{colors.signal-deep}"
    textColor: "#FFFFFF"
  button-default:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-ghost:
    backgroundColor: "{colors.light-canvas}"
    textColor: "{colors.light-ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.light-ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    height: "36px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.light-ink-secondary}"
    rounded: "{rounded.sm}"
    size: "34px"
  input:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.sm}"
    height: "36px"
    padding: "0 10px"
  panel:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  dossier-card:
    backgroundColor: "{colors.light-raised}"
    borderColor: "{colors.light-border}"
    hoverBackgroundColor: "{colors.light-sunken}"
    rounded: "{rounded.sm}"
    minHeight: "44px"
  folder-row:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.sm}"
    height: "44px"
  list-row:
    backgroundColor: "{colors.light-raised}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "44px"
  chip:
    backgroundColor: "{colors.light-sunken}"
    textColor: "{colors.light-ink-secondary}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
    height: "22px"
  safety-phrase:
    backgroundColor: "{colors.light-sunken}"
    borderColor: "{colors.light-border}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.sm}"
  reticle:
    borderColor: "{colors.signal}"
    width: "12px"
    height: "12px"
---

# Design System: QRBit

## 1. Overview & Creative North Star

**Creative North Star: "The Sealed Envelope & Cryptographic Instrument"**

QRBit is a courier, not a dashboard. The entire application experience is one continuous physical motion:
*Select or author data → Display optical beacon → Beam peer-to-peer → Leave zero trace.*

The interface balances quiet tactile stationery with cryptographic precision:
- High contrast and purposeful hierarchy.
- One vibrant accent (**Signal Blue** `#1D4ED8`) that exclusively denotes primary action.
- Dedicated semantic status colors that represent verified cryptographic states.
- Clean typography pairing: **Plus Jakarta Sans** for interfaces and **JetBrains Mono** for cryptographic data, tokens, and fingerprints.
- Strict mechanical restraint: no decorative fluff, no extraneous gradients, no third-party CDN fonts.

Every value in the design system is declared in this document and in `styles.css` / `theme.ts`.

---

## 2. Color System & Semantic Tokens

### Palette Tokens (Light & Dark)

| Token Name | Light Value | Dark Value | Role & Usage |
|---|---|---|---|
| `canvas` | `#E6E6E3` | `#0A0E17` | Root background; warm neutral in light, deep tactical in dark |
| `raised` | `#FFFFFF` | `#161C28` | Panels, cards, and modal surfaces |
| `sunken` | `#EDECE9` | `#0A0F18` | Insets, code wells, chips, and tactile slots |
| `selected` | `#F4F3F0` | `#1D2A3D` | Active selection, pressed fills, subtle highlights |
| `ink` | `#141414` | `#E9EEF6` | Primary high-contrast text and glyphs (WCAG AAA) |
| `ink-secondary`| `#5C5C58` | `#9CA3AF` | Subtitles, supporting copy, helper text |
| `ink-muted` | `#8E8E89` | `#6B7280` | Placeholders, inactive icons, subtle dividers |
| `border` | `#E4E3DF` | `#1F2937` | Section hairlines, structural dividers |
| `border-strong`| `#D6D5D0` | `#5F7391` | High-visibility control boundaries, input outlines |

### Accent & Status Tokens (Scheme-Independent)

| Token Name | Hex Value | Purpose |
|---|---|---|
| `signal` | `#1D4ED8` | Primary affirmative action (Send, Confirm, Join, Save) |
| `signal-deep`| `#1E40AF` | Pressed active state of `signal` |
| `signal-subtle`| `#E8EEFC`| Inset plates, light badge fills, QR luminance field |
| `success` | `#0E8A5F` | Completed transfer, matched safety phrase, saved state |
| `warning` | `#E5A016` | Unsaved draft, transfer in-flight, cap threshold |
| `danger` | `#D93F3F` | Fault, transfer failed, destructive deletion |
| `locked` | `#9A3412` | Double-encrypted ciphertext vault item / locked block |
| `dark-link` | `#93B4FF` | Hyperlink color on dark canvas for high legibility |

---

## 3. Typography Scale & Hierarchy

All fonts are self-hosted with `font-display: swap` (`/fonts/plus-jakarta-sans-latin.woff2` and `/fonts/jetbrains-mono-latin.woff2`).

| Role | Size | Weight | Line Height | Tracking | Purpose |
|---|---|---|---|---|---|
| **Display** | 24px | 700 | 1.2 | -0.02em | App wordmark, primary screen headline |
| **Headline** | 18px | 650 | 1.3 | -0.011em | Panel titles, modal headings |
| **Title** | 15px | 600 | 1.35 | -0.005em | Dossier names, folder headers, dialog titles |
| **Body** | 14px | 400 | 1.5 | normal | Standard prose, block content, button labels |
| **Body Secondary** | 13px | 400 | 1.45 | normal | Explanatory notes, timestamps, helper copy |
| **Label** | 12px | 600 | 1.3 | 0.01em | Form labels, status badges, counts |
| **Data** | 13px | 500 mono | 1.4 | 0.01em | Session codes, hashes, sizes, URLs, tabular figures |

**Rules:**
- **The 16px Focus Floor:** All input and textarea fields compute to `font-size: 16px` on mobile viewports to prevent iOS Safari auto-zooming.
- **The Mono Means Data Rule:** JetBrains Mono is strictly reserved for verifiable data: pairing codes, byte sizes, hashes, cryptographic keys, URLs, and timestamps.
- **Technical Dossier Mono Typographic Hierarchy:** In library trees and file dossiers, a specialized tactical hierarchy pairs monospace with clean sans:
  - Panel headline: `font-family: var(--qrbit-font-mono)`, 16px, weight 700, tracking 0.04em, uppercase.
  - Panel secondary text: `font-family: var(--qrbit-font-mono)`, 11.5px, uppercase, ink-secondary, tracking 0.03em.
  - Folder labels: `font-family: var(--qrbit-font-mono)`, 13px, weight 600, tracking -0.01em.
  - Folder item count pills: `font-family: var(--qrbit-font-mono)`, 10.5px, tracking 0.06em.
  - Dossier / file titles: `font-family: var(--qrbit-font-ui)`, 13.5px, weight 500.

---

## 4. Spacing, Radii & Depth

### Spacing Scale
- `xxs`: 2px
- `xs`: 4px
- `sm`: 8px
- `md`: 12px
- `lg`: 16px
- `xl`: 24px
- `xxl`: 32px
- `huge`: 48px

### Rounded Scale
- `xs`: 3px (tags, sub-badges)
- `sm`: 5px (controls: buttons, inputs, list rows)
- `md`: 7px (dropdowns, menus, floating sheets)
- `lg`: 10px (main panels, containers, modals)
- `full`: 999px (chips, indicator dots, circular badges)

### Elevation & Shadows
- **Resting panels:** Flat with 1px hairline border (`var(--qrbit-border)`).
- **Hover Lift (`--qrbit-shadow-lift`):** `0 1px 3px rgba(11, 18, 32, 0.10)` on light; in dark, high-contrast hairline `var(--qrbit-border-strong)`.
- **Floating Sheet (`--qrbit-shadow-sheet`):** `0 1px 2px rgba(11, 18, 32, 0.06), 0 8px 24px -8px rgba(11, 18, 32, 0.14)`. Used on modals, floating action buttons, and drag-and-drop ghost items.
- **Docked Edge-to-Edge Radius Rule:** When panels dock flush against viewport bounds in full-screen mode (header, sidebar, main viewport), outer border radii are set to 0. Resting boundaries between major architectural panes are demarcated solely by structural 1px (`var(--qrbit-border)`) and 1.5px (`var(--qrbit-border-strong)`) hairlines.

---

## 5. Component Registry & Mantine Mapping

### Shell & Full-Screen Edge-to-Edge Architecture
The application runs as a zero-margin, full-screen viewport shell (`width: 100vw; height: 100dvh; overflow: hidden;`):
- **No Exterior Void Space:** Left, right, top, and bottom gutters are eliminated entirely.
- **Flush Structural Docking:**
  - **Header (Cyber Bezel):** Spans 100% full width, flush with top, left, and right viewport edges. Radius is 0, separated from panes below with a 1.5px border-bottom (`var(--qrbit-border-strong)`).
  - **Sidebar (Acrylic Monolith):** Docked flush with left viewport edge, bottom of header, and bottom of viewport. Divided from the main workspace by a 1px border-right (`var(--qrbit-border)`).
  - **Main Workspace:** Fills remaining space edge-to-edge from the sidebar to the right viewport edge. Content centers within an internal max-width container (`max-w-2xl` to `max-w-4xl`) with comfortable padding, preventing layout stretch while eliminating exterior void space.
  - **Gaps:** The architectural layout gap between Header, Aside, and Main is strictly 0px.

### Header: Cyber Bezel (`.header-variant-acrylic-bezel`)
- **Acrylic Surface:** High-translucency glassmorphism (`rgba(244, 243, 240, 0.85)` in light, `rgba(22, 28, 40, 0.85)` in dark) with `backdrop-filter: blur(16px)` and `-webkit-backdrop-filter: blur(16px)`.
- **Identity & Brand:** High-contrast 30x30 SVG mark, bold tracking-tight Display wordmark (`font-bold tracking-tight`), uppercase monospace badge (`P2P Air-Drop // Paired`, `borderWidth: 1.5px`, tracking 0.08em).
- **Controls:** Outlined action buttons with 1px border and 44px thumb target on mobile devices.

### Sidebar: Acrylic Monolith (`.library-variant-acrylic-monolith`)
- **Acrylic Surface:** Translucent glassmorphism (`rgba(244, 243, 240, 0.7)` light, `rgba(22, 28, 40, 0.7)` dark) with `backdrop-filter: blur(12px)` and `-webkit-backdrop-filter: blur(12px)`.
- **Structural Dividing Line:** 1px hairline border on the right (`var(--qrbit-border)`), zero outer radius, flush docked to viewport.
- **Scrollport:** Independent vertical scroll with bottom clearance for floating action buttons.

### Buttons
All buttons map to Mantine primitives:
- **Primary:** `<Button color="signal">` (height 36px, padding `0 14px`, radius `sm`, white text).
- **Default:** `<Button variant="default">` (height 36px, raised fill, border-strong outline).
- **Subtle / Quiet:** `<Button variant="subtle" color="gray">` (transparent fill, ink-secondary label).
- **Danger:** `<Button color="danger">` (Fault Red fill, white text, for destructive actions).
- **Icon Action:** `<ActionIcon variant="subtle" size="lg">` (34px box, ink-secondary glyph).

### Tactical QR & Beacon HUD
- **Viewfinder Reticles:** 4 corner brackets positioned at `var(--qrbit-space-xxs)` with 2px Signal Blue borders and subtle luminous glow.
- **Luminance Well:** High-contrast field (`--qrbit-signal-subtle`) ensuring instant camera scanning in dark or direct-sunlight environments.
- **Beacon Dot:** Liveness indicator on the host session with subtle pulse animation (`animate-beacon-ping`).
- **Code Display:** 8-character monospace token (`.tactical-qr__code`) styled as a high-contrast pill with one-tap clipboard copy.

### Safety Phrase Handshake
- **3-Word Verification Display:** Curated HKDF-derived words rendered in distinct monospaced cards (`.safety-phrase__word`).
- **Sender Confirmation CTA:** Clear affirmative button: *"Confirm Safety Phrase Matches Peer"*.
- **Receiver Non-blocking Display:** Passive security notice stating verification state without blocking incoming stream.

### Local Library & Dossier Rows
- **Folder Sections:** Indented folder trees with chevron disclosure, drag handles, folder count badges, and action menus.
- **Dossier Cards:** Flat 44px minimum rows with hover background transition, leading dossier icon, name, preview snippet, and cryptographic locked badge when protected.
- **Full-Row Clickability:** Both folder rows (`.library-panel__folder-row`) and file rows (`.library-panel__file`) are fully clickable bars with `cursor: pointer` and smooth `:hover` highlight (`var(--qrbit-sunken)`). Inner text buttons and chevrons render transparent on hover to maintain a seamless, single-unit tactile bar.
- **Symmetrical Utility Controls:** Drag handles, new file `+`, and overflow `···` menu buttons share an identical 26px width (`inline-size: 26px`) for visual harmony.
- **Isolated Utility Hover via `:has()`:** Hovering over any utility action icon (drag handle, `+`, or `···` menu) uses CSS `:has()` to suppress the row bar highlight (`background-color: transparent`), focusing the hover highlight exclusively onto that specific utility icon button (`background: var(--qrbit-sunken); color: var(--qrbit-ink); border-radius: var(--qrbit-radius-sm)`).

---

## 6. How to Re-Theme & Customize this System

The system is architected as a single declarative cascade:
1. **Change a value in `DESIGN.md`:** Update hex values under `colors:`, font names under `typography:`, or spacing in frontmatter.
2. **Propagation to CSS:** `styles.css` consumes `--qrbit-*` variables that directly reflect this document.
3. **Propagation to Mantine:** `theme.ts` reads the tokens and automatically injects semantic variables to all Mantine components via the CSSOM bridge (`applyThemeCssVariables`).
4. **Validation:** Running `pnpm --filter @qrbit/frontend test` immediately confirms that `DESIGN.md`, `theme.ts`, and `styles.css` remain in exact mathematical lockstep.
