---
name: QRBit
description: "Scan a QR code. Files appear. No login. No cloud. No trace."
colors:
  signal: "#1D4ED8"
  signal-deep: "#1E40AF"
  signal-subtle: "#E8EEFC"
  success: "#0E7A5F"
  warning: "#B45309"
  danger: "#B4232A"
  locked: "#9A3412"
  light-canvas: "#F4F6F9"
  light-raised: "#FFFFFF"
  light-sunken: "#EAEEF4"
  light-selected: "#E8EEFC"
  light-ink: "#0B1220"
  light-ink-secondary: "#44546A"
  light-ink-muted: "#5C6B82"
  light-border: "#DDE3EB"
  light-border-strong: "#78889C"
  dark-canvas: "#0E1420"
  dark-raised: "#171F2C"
  dark-sunken: "#0A1017"
  dark-selected: "#1D2A3D"
  dark-ink: "#E9EEF6"
  dark-ink-secondary: "#B4C0D0"
  dark-ink-muted: "#8FA0B4"
  dark-border: "#26313F"
  dark-border-strong: "#5F7391"
  dark-link: "#93B4FF"
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
| `canvas` | `#F4F6F9` | `#0E1420` | Root background; calm neutral backdrop |
| `raised` | `#FFFFFF` | `#171F2C` | Panels, cards, and modal surfaces |
| `sunken` | `#EAEEF4` | `#0A1017` | Insets, code wells, chips, and tactile slots |
| `selected` | `#E8EEFC` | `#1D2A3D` | Active selection, pressed fills, subtle highlights |
| `ink` | `#0B1220` | `#E9EEF6` | Primary high-contrast text and glyphs (WCAG AAA) |
| `ink-secondary`| `#44546A` | `#B4C0D0` | Subtitles, supporting copy, helper text |
| `ink-muted` | `#5C6B82` | `#8FA0B4` | Placeholders, inactive icons, subtle dividers |
| `border` | `#DDE3EB` | `#26313F` | Section hairlines, structural dividers |
| `border-strong`| `#78889C` | `#5F7391` | High-visibility control boundaries, input outlines |

### Accent & Status Tokens (Scheme-Independent)

| Token Name | Hex Value | Purpose |
|---|---|---|
| `signal` | `#1D4ED8` | Primary affirmative action (Send, Confirm, Join, Save) |
| `signal-deep`| `#1E40AF` | Pressed active state of `signal` |
| `signal-subtle`| `#E8EEFC`| Inset plates, light badge fills, QR luminance field |
| `success` | `#0E7A5F` | Completed transfer, matched safety phrase, saved state |
| `warning` | `#B45309` | Unsaved draft, transfer in-flight, cap threshold |
| `danger` | `#B4232A` | Fault, transfer failed, destructive deletion |
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

---

## 5. Component Registry & Mantine Mapping

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

---

## 6. How to Re-Theme & Customize this System

The system is architected as a single declarative cascade:
1. **Change a value in `DESIGN.md`:** Update hex values under `colors:`, font names under `typography:`, or spacing in frontmatter.
2. **Propagation to CSS:** `styles.css` consumes `--qrbit-*` variables that directly reflect this document.
3. **Propagation to Mantine:** `theme.ts` reads the tokens and automatically injects semantic variables to all Mantine components via the CSSOM bridge (`applyThemeCssVariables`).
4. **Validation:** Running `pnpm --filter @qrbit/frontend test` immediately confirms that `DESIGN.md`, `theme.ts`, and `styles.css` remain in exact mathematical lockstep.
