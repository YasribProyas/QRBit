/** @vitest-environment jsdom */
/**
 * Tests for `components/HomeView.tsx` — which half of the shell holds the library, what the
 * pairing panel is allowed to claim, and where the scan control lives (ORCHESTRATION D16/D17;
 * DESIGN.md, "Layout", "Signature: the pairing panel").
 *
 * This file mounts the shell rather than `pages/Home.tsx` because the claims are about which
 * elements exist at which viewport width, and the page harness can only ever run at the width
 * its own `matchMedia` stub reports. `pages/Home.test.tsx` pins the session behaviour at the
 * desktop width (that stub answers every query with `matches: false`, which is the desktop side
 * of a `max-width` query); this file owns a stub that evaluates the query, so both halves of
 * the split are asserted in one run. The library is a stand-in node carrying `LibraryPanel`'s
 * class: the shell's whole contract is "render the node I was handed, in exactly one place",
 * and `LibraryPanel` belongs to another lane and reads IndexedDB.
 *
 * The stub evaluates `(max-width: …rem)` against a pixel width rather than returning a fixed
 * boolean on purpose. A test that forced the answer would keep passing if the breakpoint
 * drifted, and a drifted breakpoint is exactly the failure this layout cannot have: the CSS
 * grid (`lg:`, 64rem) and the rendered tree must agree about which screen a viewport is.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from './HomeView'
import type { HomeViewProps } from './HomeView'
import { APP_URL } from '../config'

const PAIRING_CODE = 'ABCDEFGH'
const SESSION_URL = `${APP_URL}/session?code=${PAIRING_CODE}`

const roots = new Set<Root>()

/**
 * Replaces `window.matchMedia` with an evaluator for `max-width: …rem` queries.
 *
 * Listeners are dropped on the floor: nothing here resizes the viewport after mount, and the
 * mount-time answer is the claim under test.
 */
function stubViewport(width: number): void {
  const matches = (query: string): boolean => {
    const max = /^\(max-width:\s*([\d.]+)rem\)$/.exec(query)
    const rem = max?.[1]
    if (rem === undefined) return false
    return width <= Number.parseFloat(rem) * 16
  }

  window.matchMedia = ((query: string) =>
    ({
      media: query,
      matches: matches(query),
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia
}

function libraryNode() {
  return (
    <div className="library-panel">
      <h2 className="qrbit-text-headline">Local Library</h2>
      <p className="qrbit-text-body-secondary">Dossiers stored on this device</p>
    </div>
  )
}

function renderView(props: Partial<HomeViewProps> = {}): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)
  roots.add(created)

  act(() => {
    created.render(
      <MemoryRouter initialEntries={['/']}>
        <HomeView
          pairingCode={PAIRING_CODE}
          onRegeneratePairing={() => undefined}
          onOpenScanner={() => undefined}
          onJoinCode={() => undefined}
          library={libraryNode()}
          {...props}
        />
      </MemoryRouter>,
    )
  })

  return element
}

/**
 * Clears the frames and the timeout Mantine's transition runs on.
 *
 * The drawer's exit is two `requestAnimationFrame` hops and then a 250ms timer, and the claim
 * being made — "the library is not in the document" — is only true after the exit finishes.
 * Yielding a frame and a macrotask is not enough; waiting out the duration is.
 */
async function settled(): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null))
      })
    })
  }
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 320)
    })
  })
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * Presses Escape the way a keyboard does: on the focused element, bubbling.
 *
 * `ModalBase` reads `event.target.getAttribute(...)`, so dispatching on `window` (whose target
 * is the window, not an element) is a synthetic event no browser would have produced.
 */
function pressEscape(): void {
  const target =
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function one(element: HTMLElement, selector: string, what: string): HTMLElement {
  const node = element.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`test bug: no ${what} (${selector})`)
  return node
}

function libraryToggle(element: HTMLElement): HTMLElement {
  return one(element, '.home__library-toggle', 'the library hamburger')
}

/** The drawer's own surface. Mantine portals it onto `document.body`, not into the container. */
function drawer(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')
}

function copies(): number {
  return document.querySelectorAll('.library-panel').length
}

function setClipboard(write: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write } as unknown as Clipboard,
  })
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterEach(async () => {
  for (const created of roots) {
    await act(async () => {
      created.unmount()
    })
  }
  roots.clear()
  document.body.innerHTML = ''
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
  vi.restoreAllMocks()
})

describe('HomeView — one library, placed by the viewport (D17 item 5)', () => {
  it('does not stack the library under the QR on a phone: it is absent until the hamburger opens', async () => {
    stubViewport(390)
    const element = renderView()

    // Not hidden, not zero-width, not stacked under the pairing panel: not there.
    expect(element.querySelector('.library-panel')).toBe(null)
    expect(element.querySelector('.home__library')).toBe(null)
    expect(drawer()).toBe(null)
    expect(copies()).toBe(0)

    const toggle = libraryToggle(element)
    expect(toggle.getAttribute('aria-label')).toBe('Open the local library')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    click(toggle)
    await settled()

    const sheet = drawer()
    if (sheet === null) throw new Error('test bug: the drawer did not open')
    expect(sheet.querySelector('.library-panel')?.textContent).toContain('Local Library')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // One instance, moved: the aside did not stay mounted behind the sheet.
    expect(copies()).toBe(1)
    expect(element.querySelector('.home__library')).toBe(null)

    click(toggle)
    await settled()
    expect(drawer()).toBe(null)
    expect(copies()).toBe(0)
  })

  it('holds focus inside the sheet and hands it back to the hamburger on Escape', async () => {
    stubViewport(390)
    const element = renderView()
    const toggle = libraryToggle(element)

    toggle.focus()
    click(toggle)
    await settled()

    const sheet = drawer()
    if (sheet === null) throw new Error('test bug: the drawer did not open')
    expect(sheet.contains(document.activeElement)).toBe(true)

    pressEscape()
    await settled()

    expect(drawer()).toBe(null)
    expect(document.activeElement).toBe(toggle)
  })

  it('shows the library in the left column and mounts neither a hamburger nor a drawer on a desktop', async () => {
    stubViewport(1280)
    const element = renderView()

    expect(element.querySelector('.home__library .library-panel')).not.toBe(null)
    // Not hidden behind a utility: neither control is in the tree at all.
    expect(element.querySelector('.home__library-toggle')).toBe(null)
    expect(drawer()).toBe(null)
    expect(copies()).toBe(1)

    // And nothing appears later either — there is no hidden sheet waiting to be shown.
    await settled()
    expect(drawer()).toBe(null)
    expect(copies()).toBe(1)
  })

  it('switches on DESIGN.md desktop breakpoint, not somewhere near it', () => {
    // 1023px is the last phone width; the grid next door flips at 1024px (Tailwind `lg`, 64rem).
    stubViewport(1023)
    const phone = renderView()
    expect(phone.querySelector('.home__library-toggle')).not.toBe(null)
    expect(phone.querySelector('.home__library')).toBe(null)
  })
})

describe('HomeView — the pairing panel has a title (D17 item 1)', () => {
  it('titles the right panel with a headline and a Body Secondary subline, not an eyebrow', () => {
    stubViewport(1280)
    const element = renderView()

    const heading = one(element, '.home__pairing-heading', 'the pairing panel heading')
    expect(heading.querySelector('h2.qrbit-text-headline')?.textContent).toBe('Pair another device')
    expect(heading.querySelector('.qrbit-text-body-secondary')?.textContent).toContain(
      'scanning the code',
    )

    // A headline, not a kicker: it is the first thing in the column, and there is no uppercase
    // eyebrow class anywhere in the shell.
    expect(heading.previousElementSibling).toBe(null)
    expect(element.querySelector('.page__section-title')).toBe(null)
  })

  it('keeps the title while the host session is still being minted', () => {
    stubViewport(1280)
    const element = renderView({ pairingCode: null })

    expect(element.querySelector('h2.qrbit-text-headline')?.textContent).toBe('Pair another device')
    expect(element.textContent).toContain('Connecting host session')
    // …and the panel still promises no code it does not have (D13, D15).
    expect(element.querySelector('.session-qr')).toBe(null)
    expect(element.textContent).not.toContain(SESSION_URL)
  })

  it('renders the pairing panel flat and seamless without a white raised surface', () => {
    stubViewport(1280)
    const element = renderView()

    const panel = one(element, '.home__pairing-panel', 'the pairing panel')
    expect(panel.style.background).toBe('transparent')
    expect(panel.style.border).toBe('none')
    // …and no third shadow: a resting surface is flat ("The Floating Only Rule").
    expect(panel.style.boxShadow).toBe('none')
  })

  it('keeps the code plate light and spends Sunken on the inset', () => {
    stubViewport(1280)
    const element = renderView()

    expect(one(element, '.tactical-qr__well', 'the code plate').style.background).toContain(
      'var(--qrbit-signal-subtle)',
    )
    expect(one(element, '.tactical-qr__link-row', 'the link inset').style.background).toContain(
      'var(--qrbit-sunken)',
    )
  })

  /*
   * The reported defect: the link row drew *across* the panel's border — 34px past each edge in a
   * 1280×900 browser, straight through the corner reticles — because the block that holds it was
   * sized by its own max-content (an unstretched flex item in a centred column), so its
   * `width: 100%` resolved against nothing. jsdom lays nothing out, so this cannot be asserted as
   * a rectangle; it is asserted as the declaration that makes the rectangle impossible: the
   * block has a definite width, so the row inside it cannot be wider than the card.
   *
   * The geometry was measured in a headless browser instead: the row's box is inside the card's
   * padding box (content 416px, row 416px, card 448px) at 1280, 1024 and 1600 wide, where the
   * previous layout overflowed at all three.
   */
  it('keeps the link row inside the card the reticles mark out', () => {
    stubViewport(1280)
    const element = renderView()

    const qr = one(element, '.tactical-qr', 'the code block')
    expect(qr.style.width).toBe('100%')
    // The row is a child of that definite width, and it is the card's content box that owns it.
    const row = one(element, '.tactical-qr__link-row', 'the link row')
    expect(qr.contains(row)).toBe(true)
    expect(row.style.width).toBe('100%')
    // It is not sitting on the panel's border: it is a flow child of the panel, below the plate.
    expect(row.closest('.home__pairing-panel')).not.toBe(null)
    expect(row.parentElement?.classList.contains('tactical-qr__label')).toBe(true)
    expect(row.style.position).toBe('')
    // The anchor is the only thing allowed to clip, and it is the head that does.
    expect(one(element, '.tactical-qr__link-head', 'the clipped half').style.textOverflow).toBe(
      'ellipsis',
    )
    expect(one(element, '.tactical-qr__link-code', 'the code tail').style.flexGrow).toBe('0')
  })

  it('displays the session code as its own line, in the Data role, not only inside the URL', () => {
    stubViewport(1280)
    const element = renderView()

    const code = one(element, '.tactical-qr__code', 'the code line')
    expect(code.tagName).toBe('CODE')
    expect(code.textContent).toBe(PAIRING_CODE)
    // The repo's session-code primitive: the Data role's mono family and tabular figures at the
    // size a person can read across a table (`styles.css`'s `.code`, which also carries the
    // 0.18em tracking the typed field uses, so the two renderings of the code look alike).
    expect(code.className).toContain('code')
    expect(code.style.fontVariantNumeric).toBe('tabular-nums')
    // It is on the panel, not on the light plate: `--qrbit-ink` flips with the scheme and the
    // plate deliberately does not, so code painted on the plate would be light-on-light in dark.
    expect(code.closest('.tactical-qr__well')).toBe(null)
    expect(one(element, '.home__pairing-panel', 'the pairing panel').contains(code)).toBe(true)
    // And the link row still carries the whole address (the copy control's contract).
    expect(one(element, '.tactical-qr__link', 'the link').textContent).toBe(SESSION_URL)
  })

  it('shows no code line before the host has joined one', () => {
    stubViewport(1280)
    const element = renderView({ pairingCode: null })
    expect(element.querySelector('.tactical-qr__code')).toBe(null)
  })

  it('keeps the status dot on the first line of its own sentence', () => {
    stubViewport(1280)
    const element = renderView()

    const status = one(element, '.session-qr__status', 'the status line')
    const dot = one(status, '.home__status-dot', 'the status dot')
    const text = one(status, '.session-qr__status-text', 'the status sentence')
    // Top-aligned row, so a wrapping sentence cannot carry the dot to its vertical middle; the
    // dot's own top inset is half the Body line box less the dot's height.
    expect(status.style.getPropertyValue('--group-align')).toBe('flex-start')
    expect(dot.style.flexShrink).toBe('0')
    expect(dot.style.marginTop).toBe('calc((1.5em - var(--qrbit-space-sm)) / 2)')
    // The text is the flexible half: it may give its width back, the dot may not.
    expect(text.style.minWidth).toBe('0px')
  })
})

describe('HomeView — the link a peer opens (D17 items 2, 3)', () => {
  it('keeps the whole URL in the document while showing one clipped line', () => {
    stubViewport(390)
    const element = renderView()

    const link = element.querySelector<HTMLAnchorElement>('.tactical-qr__link')
    if (!link) throw new Error('test bug: no session link')
    expect(link.href).toBe(SESSION_URL)
    // The DOM carries the full address: it is what the copy control writes, what a paste would
    // yield, and what `pages/Home.test.tsx` asserts is on screen. Only the origin's pixels are
    // clipped, so the code a user checks by eye cannot be the thing that disappears.
    expect(link.textContent).toBe(SESSION_URL)

    expect(link.style.whiteSpace).toBe('nowrap')
    expect(link.style.overflow).toBe('hidden')
    expect(one(element, '.tactical-qr__link-head', 'the clipped half').style.textOverflow).toBe(
      'ellipsis',
    )

    const tail = one(element, '.tactical-qr__link-code', 'the code half')
    expect(tail.textContent).toBe(`?code=${PAIRING_CODE}`)
    expect(tail.style.flexGrow).toBe('0')
    expect(tail.style.flexShrink).toBe('0')
  })

  it('copies the full link and says so', async () => {
    stubViewport(1280)
    const writeText = vi.fn(async (_text: string): Promise<void> => undefined)
    setClipboard(writeText)
    const alert = vi.spyOn(window, 'alert')

    const element = renderView()
    const copy = one(element, '.tactical-qr__copy', 'the copy control')
    expect(copy.getAttribute('aria-label')).toBe('Copy the full session link')

    click(copy)
    await settled()

    expect(writeText).toHaveBeenCalledWith(SESSION_URL)
    expect(alert).not.toHaveBeenCalled()
    expect(copy.getAttribute('aria-label')).toBe('Session link copied')
    expect(one(element, '.tactical-qr__copy-status', 'the copy status').textContent).toBe(
      'The full link is on your clipboard.',
    )
  })

  it('reports a refused write instead of claiming one happened', async () => {
    stubViewport(1280)
    setClipboard(async (): Promise<void> => {
      throw new Error('NotAllowedError')
    })
    const alert = vi.spyOn(window, 'alert')

    const element = renderView()
    const copy = one(element, '.tactical-qr__copy', 'the copy control')

    click(copy)
    await settled()

    expect(alert).not.toHaveBeenCalled()
    expect(copy.getAttribute('aria-label')).toBe('Copy blocked by this browser')
    expect(one(element, '.tactical-qr__copy-status', 'the copy status').textContent).toContain(
      'blocked the copy',
    )
  })

  it('reports a clipboard the browser never offered', async () => {
    stubViewport(1280)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })

    const element = renderView()
    click(one(element, '.tactical-qr__copy', 'the copy control'))
    await settled()

    expect(one(element, '.tactical-qr__copy-status', 'the copy status').textContent).toContain(
      'blocked the copy',
    )
    expect(element.querySelector('[aria-label="Session link copied"]')).toBe(null)
  })

  it('gives the copy control the documented icon-only treatment, not an inline colour', () => {
    stubViewport(1280)
    const element = renderView()

    const copy = one(element, '.tactical-qr__copy', 'the copy control')
    // DESIGN.md's icon-only row is a quiet control with an Ink Secondary glyph. The control was
    // invisible in the light scheme because the slot that colour comes from never reached the
    // page — `style-src 'self'` refused the inline `<style>` Mantine delivers its variables in,
    // so the chain fell through to white on a white panel. That is the bridge's defect and the
    // bridge fixed it (375df54); what this test pins is that the component asks for the
    // documented variant and states no colour of its own.
    expect(copy.getAttribute('data-variant')).toBe('subtle')
    expect(copy.style.getPropertyValue('--ai-bg')).toBe('transparent')
    expect(copy.style.getPropertyValue('--ai-color')).toBe('var(--mantine-color-dimmed)')
    // 44px: a thumb target on the device that is being held over the other one.
    expect(copy.style.getPropertyValue('--ai-size')).toBe('var(--ai-size-xl)')
  })

  it('offers no link and no copy control before there is a link to copy', () => {
    stubViewport(1280)
    const element = renderView({ pairingCode: null })

    expect(element.querySelector('.tactical-qr__link')).toBe(null)
    expect(element.querySelector('.tactical-qr__copy')).toBe(null)
  })
})

describe('HomeView — the floating scan control (D17 item 4)', () => {
  it('is icon-only, named, and outside the panel it belongs to', () => {
    stubViewport(1280)
    const element = renderView()

    const scan = one(element, '.home__scan', 'the scan control')
    expect(scan.getAttribute('aria-label')).toBe('Scan and send')
    expect(scan.textContent).toBe('')
    expect(scan.closest('.home__pairing-panel')).toBe(null)
    expect(scan.closest('.session-qr')).toBe(null)
    expect(scan.closest('.manual-code')).toBe(null)
    expect(scan.closest('header')).toBe(null)
    // The in-panel button it replaced is gone, not hidden behind it.
    expect(element.querySelectorAll('.home__scan')).toHaveLength(1)
    expect(element.textContent).not.toContain('Scan & Send')
    // Signal fill, the one affirmative colour, and the glyph of the thing it reads.
    expect(scan.style.getPropertyValue('--ai-bg')).toBe('var(--mantine-color-signal-filled)')
  })

  it('sits in a reserved band that is the shell’s last row, at every viewport width', () => {
    for (const width of [320, 768, 1024, 1280, 1600]) {
      stubViewport(width)
      const element = renderView()

      const scan = one(element, '.home__scan', 'the scan control')
      const band = scan.parentElement
      if (!(band instanceof HTMLElement)) throw new Error(`test bug: no band at ${width}px`)
      expect(band.classList.contains('home__fab-band')).toBe(true)

      // The overlap argument, as data rather than as intent: the band is a row of the shell
      // that takes no share of the free height, and the panels row is the sibling before it.
      // So the QR block, its reticle corners and the manual-code field are laid out ABOVE the
      // space the control occupies — at any scroll offset, because the control never leaves it.
      expect(band.style.flexGrow).toBe('0')
      expect(band.style.flexShrink).toBe('0')
      expect(band.parentElement?.lastElementChild).toBe(band)
      const panels = band.previousElementSibling
      if (!(panels instanceof HTMLElement)) throw new Error(`test bug: no panels row at ${width}px`)
      expect(panels.classList.contains('home__panels')).toBe(true)

      // Pinned inside the height the band already claimed, and lifted by the safe area on a
      // notched phone so it never sits on the home-indicator strip.
      expect(scan.style.position).toBe('absolute')
      expect(scan.style.left).toBe('var(--qrbit-space-lg)')
      expect(scan.style.bottom).toContain('env(safe-area-inset-bottom')
      expect(band.style.height).toContain('env(safe-area-inset-bottom')
      // Above the page, below the drawer and the modals (which are `modal`/`popover` level).
      expect(scan.style.zIndex).toBe('var(--mantine-z-index-app)')
      // 44px target.
      expect(scan.style.getPropertyValue('--ai-size')).toBe('var(--ai-size-xl)')
    }
  })

  /*
   * The defect this replaces: the control was `position: fixed`, so its box was resolved against
   * the nearest ancestor that establishes a containing block and against the *viewport* when no
   * such ancestor exists. Neither answer is the band's, which is the only place on the shell that
   * promises the control a space nothing else is laid out in — at 1600px wide the shell is
   * `max-width: 84rem` and centred, so the fixed control sat 123px left of the band's own edge,
   * in the gutter outside the page.
   *
   * What jsdom can and cannot assert here, stated plainly: it runs no layout and resolves no
   * `var()`, so the old failure was not observable in a test either way. What it CAN assert is
   * the contract the fix is made of — the button is a child of a box that establishes its own
   * containing block (`position: relative`), the chain from the band to the document holds no
   * inline `transform`/`filter`/`backdrop-filter`/`perspective`/`will-change`/`contain` (those
   * are the only such declarations in the shell: `styles.css` sets none), and the node the
   * handler is bound to is the node the tests and the user reach. The geometry itself was
   * measured in a headless browser, not here.
   */
  it('is pinned to a box of its own, not to the viewport', () => {
    stubViewport(1600)
    let opened = 0
    const element = renderView({
      onOpenScanner: () => {
        opened += 1
      },
    })

    const scan = one(element, '.home__scan', 'the scan control')
    const band = scan.parentElement
    if (!(band instanceof HTMLElement)) throw new Error('test bug: no band')

    // The band is the containing block: it is positioned, and the control is inside it.
    expect(band.style.position).toBe('relative')
    expect(scan.style.position).toBe('absolute')

    // Nothing between the band and the document establishes one instead.
    const CONTAINING_BLOCK_PROPERTIES = [
      'transform',
      'filter',
      'backdropFilter',
      'perspective',
      'willChange',
      'contain',
    ] as const
    const offenders: string[] = []
    for (let node: HTMLElement | null = band; node !== null; node = node.parentElement) {
      for (const property of CONTAINING_BLOCK_PROPERTIES) {
        if (node.style.getPropertyValue(property) !== '') {
          offenders.push(`${node.className || node.tagName}:${property}`)
        }
      }
    }
    expect(offenders).toEqual([])

    // One node carries the class, and it is the node the handler is bound to.
    expect(element.querySelectorAll('.home__scan')).toHaveLength(1)
    click(scan)
    expect(opened).toBe(1)
  })

  it('opens the camera when the floating control is pressed', () => {
    stubViewport(390)
    let opened = 0
    const element = renderView({
      onOpenScanner: () => {
        opened += 1
      },
    })

    click(one(element, '.home__scan', 'the scan control'))
    expect(opened).toBe(1)
  })

  it('carries no selection count, because nothing on this screen can make a selection', () => {
    stubViewport(1280)
    const element = renderView()

    expect(element.textContent).not.toContain('selected')
    expect(one(element, '.home__scan', 'the scan control').children).toHaveLength(1)
  })
})

describe('HomeView — the hooks the pairing tests reach for', () => {
  it('keeps every selector the page-level tests select', () => {
    stubViewport(1280)
    const element = renderView()

    expect(element.querySelector('.home__qr-panel')).not.toBe(null)
    expect(element.querySelector('.home__qr-error')).toBe(null)
    expect(element.querySelector('.session-qr')).not.toBe(null)
    expect(element.querySelector('.home__pairing-panel')).not.toBe(null)
    expect(element.querySelector('.home__manual-fallback .manual-code')).not.toBe(null)
    expect(element.querySelector('.manual-code__input')).not.toBe(null)
    expect(element.querySelector('.manual-code__submit')).not.toBe(null)
    expect(element.querySelector('.home__settings')).not.toBe(null)
    expect(element.querySelector('.home__scan')).not.toBe(null)
  })

  it('surfaces a signaling failure without claiming a code', () => {
    stubViewport(1280)
    const element = renderView({ pairingCode: null, errorMessage: 'websocket refused' })

    const error = one(element, '.home__qr-error', 'the error panel')
    expect(error.textContent).toContain('Could not reach the signaling server')
    expect(error.textContent).toContain('websocket refused')
    expect(element.querySelector('.session-qr')).toBe(null)
    // The retry is still reachable, and the typed fallback is still beside it.
    expect(error.querySelector('button')?.textContent).toBe('Try again')
    expect(element.querySelector('.manual-code')).not.toBe(null)
  })
})
