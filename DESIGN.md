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
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    height: "36px"
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
---

# Design System: QRBit

## Overview

**Creative North Star: "The Sealed Envelope"**

QRBit is a courier, not a dashboard. The whole product is one motion — put something in,
show a code, hand it across, and leave no trace — so the interface should feel like clean
stationery with a locking tab: quiet surfaces, exact alignment, one accent that always means
*this is the action*, and visible mechanics only where the security story is actually being
told. It is an Operate-mode tool: the visitor is completing a task with a second device in
their hand, often standing, often on a phone. Expression lives in precision (alignment,
rhythm, contrast), never in decoration.

The previous system's failure was not taste but arithmetic: 134 hand-written `<button>`s
against 14 real components, 40 hardcoded hex values used 281 times, and font sizes of 10, 11
and 13 pixels pulled from the air. Each screen was authored by a different agent at a
different time, so the product looked like a folder of screenshots rather than one application.
This document exists to make that impossible: **every value a component may use is listed
here, and nothing outside the list is allowed.**

**Key Characteristics:**
- Two-panel desktop, single-column mobile, one grid on both.
- Light by default, dark by preference, decided once at `:root` — never per component.
- One accent (signal blue). Colour is used for state and meaning, not for variety.
- Flat list rows, no nested surfaces. Depth is reserved for things that float above content.
- Zero third-party requests. The product must not leak a visitor to anyone, including fonts.

## Colors

Restrained and cool: near-white paper, blue-black ink, one saturated signal. Colour carries
meaning, so meaning is rationed.

All pairs below were computed, not assumed. Text tokens clear WCAG AA (≥4.5:1) on every
surface in their own scheme; graphical affordances clear ≥3:1.

### Primary
- **Signal Blue** (#1D4ED8): the only affirmative action in the product — Send, Join, Save,
  Confirm. White label on it reads 6.70:1. Never used for decoration, headings, or icons at
  rest.
- **Signal Deep** (#1E40AF): the pressed state of Signal and nothing else. It is not a second
  primary.
- **Signal Subtle** (#E8EEFC): selected rows, focus tints, the inside of a light-filled chip.

### Status
- **Locked Rust** (#9A3412): encryption state — a locked dossier, a ciphertext badge. This is
  the product's signature meaning and it is reserved for exactly that.
- **Verified Green** (#0E7A5F): a completed transfer, a matched safety phrase, a saved item.
- **Caution Amber** (#B45309): a warning that is not a failure (unsaved draft, size nearing a
  cap).
- **Fault Red** (#B4232A): a real error and destructive confirmation only.

### Neutral
- Light: **Canvas** #F4F6F9 (page), **Raised** #FFFFFF (panels, inputs), **Sunken** #EAEEF4
  (code wells, insets), **Selected** #E8EEFC, **Ink** #0B1220, **Ink Secondary** #44546A,
  **Ink Muted** #5C6B82, **Border** #DDE3EB (decorative division), **Border Strong** #78889C
  (the outline of a control the user must find).
- Dark: **Canvas** #0E1420, **Raised** #171F2C, **Sunken** #0A1017, **Selected** #1D2A3D,
  **Ink** #E9EEF6, **Ink Secondary** #B4C0D0, **Ink Muted** #8FA0B4, **Border** #26313F,
  **Border Strong** #5F7391, **Link** #93B4FF.

### Named Rules
**The One Blue Rule.** #1D4ED8 is the only primary and #1E40AF only ever means *pressed*. A
second blue on screen is a defect, not a variant.

**The No Raw Hex Rule.** A hex literal in a `.tsx` is a bug. Components consume tokens
(`var(--qrbit-*)` or the matching Mantine semantic colour). The old code hardcoded the exact
value its own theme token already defined — 281 times.

**The Meaningful Colour Rule.** Status colour appears on status. If a surface is neither
confirming, warning, nor failing, it is neutral.

**The Invisible Is Not Quiet Rule.** An affordance a user must find (input outline, grip,
icon-only control) clears 3:1 against its background. `#94A3B8` on the page was 2.28:1, which
is why the drag handle read as a smudge rather than a handle.

## Typography

**Display/Body Font:** Plus Jakarta Sans (self-hosted, variable, 400–700), system fallback.
**Data Font:** JetBrains Mono (self-hosted, 400/500/600).
**Third family:** removed. Space Grotesk is gone; hierarchy comes from weight and size, which
is what the previous stack was really using three families to fake.

**Character:** a single humanist geometric sans doing every job, with mono reserved for things
that are literally data. It reads as an instrument, not a terminal.

### Hierarchy
| Role | Size / weight / line-height | Use |
|---|---|---|
| Display | 24 / 700 / 1.2, tracking −0.02em | Product name, one per view maximum |
| Headline | 18 / 650 / 1.3 | Panel and section titles |
| Title | 15 / 600 / 1.35 | Row titles, dialog titles, group labels |
| Body | 14 / 400 / 1.5 | The default. All prose, all labels |
| Body Secondary | 13 / 400 / 1.45 | Supporting lines, helper text |
| Label | 12 / 600 / 1.3, tracking 0.01em | Field labels, badges, counts |
| Data | 13 / 500 mono | Session codes, byte counts, URLs, timestamps |

Body measure 65–75ch where prose runs long (dossier notes, settings descriptions).

### Named Rules
**The 12px Floor.** Nothing is ever 10px or 11px. The old UI used 35×`text-[11px]` and
8×`text-[10px]`; both are below the floor and both were unreadable on a phone in sunlight,
which is a primary usage scene for this product.

**The Mono Means Data Rule.** Monospace is for values a user might read back to someone:
codes, sizes, hashes, URLs. It is not a costume for "technical". If the string is prose, it is
Plus Jakarta Sans.

**The Weight Before Colour Rule.** Emphasis is weight or size, never hue. Two weights of one
family out-signal three families of mixed weights.

## Layout

Two panels on desktop, one column on mobile, decided by a single breakpoint set: `sm 480 / md
768 / lg 1024 / xl 1280`.

- **Desktop shell** (≥1024): fixed-height, `grid-template-columns: minmax(320px, 26rem) 1fr`.
  Library left, session/QR right. Each column scrolls independently; the shell never scrolls.
  Gap `xl` (24px), page padding `xl` (24px).
- **Mobile shell** (<1024): one column, session first, library second, in flow. No drawer —
  a drawer hides the object the user came for.
- **Spacing scale** 2 / 4 / 8 / 12 / 16 / 24 / 32 / 48. Compose with it; a value not on the
  scale is drift.
- **Rhythm:** tight inside a control (xs–sm), generous between groups (xl–xxl), and always more
  space *above* a heading than below it (heading `mt-xl`, subline `mt-xs`).
- Max content width for prose 68ch; the QR panel centres its code at a 195–240px target so a
  phone camera can read it from arm's length.

## Elevation & Depth

Light mode is mostly flat: borders separate, shadows only appear when something genuinely
floats above the page. Dark mode conveys depth through surface steps (canvas → raised →
sunken) and hairlines, not shadows, because a black shadow on a near-black page is invisible.

### Shadow Vocabulary
- **`--qrbit-shadow-sheet`** (`0 1px 2px rgba(11,18,32,.06), 0 8px 24px -8px rgba(11,18,32,.14)`):
  modals, popovers, the drag-ghost row.
- **`--qrbit-shadow-lift`** (`0 1px 3px rgba(11,18,32,.10)`): a hovered row that is actionable.
- Nothing else. Two shadows for a whole product is a system; twelve is a noise floor.

### Named Rules
**The Offset-and-Blur Rule.** Every shadow has a vertical offset and a real blur radius. A
zero-offset coloured halo is decoration, not depth, and this product already ships one (`shadow-2xs`
under a sticky header) that does nothing.

**The Floating Only Rule.** A resting surface is flat with a 1px border. Shadow is a response
to state — hover, drag, open — or a mark that the element is above the page.

## Shapes

Gently curved, mechanical, consistent: **sm 5px** for controls (buttons, inputs, rows), **md
7px** for menus and popovers, **lg 10px** for panels, **full** for chips and status dots only.
Borders are 1px, always `border` for division and `border-strong` where the user must locate a
control (inputs, focus, the drag grip's hit area).

The one intentional exception to rectangular calm: the QR panel carries corner reticles — real
viewfinder marks, drawn from the scanning gesture, not a decorative frame. It is the product's
signature geometry and it appears on exactly that panel.

**The One Radius Family Rule.** Controls 5px, containers 10px. Never `rounded-xl`/`2xl` on a
button, and never mixed radii inside one control.

## Components

Character: restrained and tactile. Controls look pressable because of border and fill, not
because of a gradient.

### Buttons
Only Mantine primitives: `<Button>` for labelled actions, `<ActionIcon>` for icon-only,
`<Unstyled>`/`<Text>` are not buttons. **134 raw `<button>` elements get replaced; that count
is the single biggest defect in this codebase.**

| Variant | Fill | Text | Height | Padding |
|---|---|---|---|---|
| Primary (`color="signal"`, filled) | Signal | #FFFFFF | 36 (sm 32) | 0 14px |
| Default (`variant="default"`) | Raised, 1px Border Strong | Ink | 36 (sm 32) | 0 12px |
| Quiet (`variant="subtle"`) | transparent | Ink Secondary | 32 | 0 10px |
| Danger (`color="danger"`) | Fault Red | #FFFFFF | 36 | 0 14px |
| Icon-only (`<ActionIcon variant="subtle">`) | transparent | Ink Secondary | 32 | 8px box |

Hover lifts the fill one step; active moves to the documented pressed colour; focus is a 2px
`--qrbit-ring-signal` outline offset 2px. Disabled loses saturation *and* pointer events, never
opacity alone below 45% contrast.

### Inputs and Fields
Raised fill, 1px **Border Strong** outline (a control the user must find is not 1.19:1 —
the old `#D1D9E4` was decoration used as a boundary), 5px radius, 36px tall, label above at
Label role, helper text at Body Secondary, error text in Fault Red with a real message.
The 8-character session code field uses the Data role and 48px targets on mobile, because it
is typed on a phone.

**The 16px focus floor.** Anything a user types into computes `font-size: 16px`, regardless of
which role its *text* would otherwise use: below 16px, iOS Safari zooms the entire page the
moment the field takes focus, and this product's primary device is a phone. The type roles
govern reading; this governs touch, and the two are not in conflict — a 16px input with the
Body role's weight and line-height still reads as Body. The mechanical detector flags `16px`
as off-ramp; that flag is the intended exception, not a finding to fix. Set it at the
declaration that applies (class selectors beat a document-wide element rule on specificity,
not on cascade layers), and remember an unlayered class rule outranks a `@layer base` rule.

### Panels and Rows
**Panel**: Raised, 1px Border, radius lg, padding lg, no shadow at rest.
**Row** (library dossier, folder header): flat, 44px min height, one 1px division between
rows, never a bordered card containing a bordered card. Selected row gets Selected fill plus a
2px Signal inset on its leading edge — that is the only place a coloured edge is allowed, and
it is 2px of *selection state*, not decoration.
Grip uses Ink Muted (4.03:1 min) and becomes Ink on hover.

### Badges and Chips
Chips: Sunken fill, Ink Secondary text, radius full, 22px tall, Label role.
Status badges carry an icon and a word — Encrypted, Unsaved, Complete. A badge never relies on
colour alone.

### Dialogs
Mantine `<Modal>`, radius md, shadow-sheet, title at Title role, actions right-aligned in the
order Quiet then Primary, destructive confirmations using Danger and naming the consequence
("Delete folder and 3 dossiers"). Escape always cancels; focus returns to the invoker.

### Navigation
One header: wordmark left, `Settings` and account-free status right. On mobile the header is
44px tall with 16px side padding. `/settings` is reachable in one tap from anywhere — a route
with no entry point is a route that does not exist.

### Signature: the pairing panel
Reticle corners, a status dot plus a three-word line, the QR at 195–240px on a Raised well,
`Scan & Send` beneath it, and the manual-code fallback separated by a hairline. It is the only
place the product shows its mechanics, so it is the only place that earns geometry.

## Do's and Don'ts

### Do:
- **Do** consume tokens: `var(--qrbit-ink)`, `var(--qrbit-border-strong)`, or a Mantine
  semantic colour defined in `theme.ts`. Every component reads the same 18 names.
- **Do** ship both schemes from one declaration set. `[data-theme]` decides; components never
  know which scheme they are in.
- **Do** use one of the seven type roles, exactly.
- **Do** keep the 44px minimum touch target on mobile for anything a thumb hits.
- **Do** self-host fonts from `/fonts/` with `font-display: swap`. `font-src 'self'` and
  `style-src 'self'` are not negotiable, so a CDN font is blocked by our own policy — which is
  precisely why the current build renders in system fallbacks on every device.
- **Do** state a control's action in its label: "Save dossier", "Move to folder", "Delete file".
- **Do** give every drag a keyboard path and every icon-only control an `aria-label`.

### Don't:
- **Don't** write a hex value inside a component. 281 uses across 40 values is the disease this
  document cures.
- **Don't** write `<button>`. Use the Button table above. If a control genuinely needs custom
  markup, it still gets the tokens, the states, and the focus ring.
- **Don't** use `text-[10px]`, `text-[11px]`, or an ad-hoc `text-[13px]` outside the roles.
- **Don't** nest a card in a card, or add a third shadow.
- **Don't** add an `unsafe-inline` or a third-party origin to the CSP to make a design task
  easier. React sets styles through the CSSOM, which CSP does not restrict — `style={{...}}`
  is legal, `<style>` blocks and inline `style="..."` markup are not.
- **Don't** send a user's request to a third party for styling, analytics, or fonts. The
  product's promise is "No cloud. No trace." A CDN webfont breaks that promise in the header
  of the HTML, before any JavaScript runs.
- **Don't** add a decorative gradient, blur, or glass surface. Depth is functional or absent.
- **Don't** create a new icon style: `@tabler/icons-react`, one stroke weight, 16–20px.
  `lucide-react` is removed; the app previously shipped the same glyph from both libraries.
- **Don't** render data the user did not provide. An attachment block that displays
  "attachment_photo.png · 2.4 MB" while holding nothing is not a placeholder, it is a lie, and
  the send path silently fabricated 100 null bytes behind it.
