/** @vitest-environment jsdom */
/**
 * Tests for `components/ManualCodeEntry.tsx` (PLAN.md §8's typed fallback, §16 Phase 6).
 *
 * The component's whole job is untrusted-input handling: the code a user types is
 * validated against the Phase 1 alphabet BEFORE it becomes a `/session?code=X`
 * navigation, so a typo cannot become a request the worker rejects with a 400. These
 * tests drive the real router and assert the destination, not a callback.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ManualCodeEntry } from './ManualCodeEntry'

const VALID_CODE = 'A7X3K9P2'

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

/**
 * The landing route mirrors what `pages/Session.tsx` reads from the URL: the `code`
 * param. It records the search string so a test can assert whether a navigation
 * happened and what it carried.
 */
function SessionLanding() {
  const location = useLocation()
  return <div className="session-landing" data-search={location.search} />
}

function renderEntry(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  const created = createRoot(element)

  act(() => {
    created.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ManualCodeEntry />} />
          <Route path="/session" element={<SessionLanding />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  container = element
  root = created
  return element
}

function codeInput(element: HTMLElement): HTMLInputElement {
  const input = element.querySelector('.manual-code__input')
  if (!(input instanceof HTMLInputElement)) throw new Error('test bug: no code input')
  return input
}

/** Types through the same path a keyboard uses, so React's controlled value updates. */
function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('test bug: value has no setter')
  setter.call(field, value)

  act(() => {
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(element: HTMLElement): void {
  const form = element.querySelector('form')
  if (!(form instanceof HTMLFormElement)) throw new Error('test bug: no form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function landingSearch(element: HTMLElement): string | null {
  const landing = element.querySelector<HTMLElement>('.session-landing')
  return landing === null ? null : landing.getAttribute('data-search')
}

function errorText(element: HTMLElement): string | null {
  return element.querySelector('.manual-code__error')?.textContent ?? null
}

beforeEach(() => {
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = undefined
})

describe('ManualCodeEntry (PLAN.md §8, §16 Phase 6)', () => {
  it('joins the session with the typed code', () => {
    const element = renderEntry()

    typeInto(codeInput(element), VALID_CODE)
    submit(element)

    expect(landingSearch(element)).toBe(`?code=${VALID_CODE}`)
  })

  it('uppercases what it shows and submits the exact code the worker issued', () => {
    const element = renderEntry()

    typeInto(codeInput(element), VALID_CODE.toLowerCase())

    // The worker does no case normalisation, so a lower-case code would 400. The field
    // produces the upper-case form the alphabet actually uses...
    expect(codeInput(element).value).toBe(VALID_CODE)

    submit(element)

    // ...and that exact string is what navigates.
    expect(landingSearch(element)).toBe(`?code=${VALID_CODE}`)
  })

  it('refuses a code that is not eight characters long', () => {
    const element = renderEntry()

    typeInto(codeInput(element), 'A7X3K9P')
    submit(element)

    expect(landingSearch(element)).toBe(null)
    expect(errorText(element)).toContain('exactly 8 characters')
  })

  it('refuses a code with a character outside the session alphabet', () => {
    const element = renderEntry()

    // 'O' is the glyph the Phase 1 alphabet deliberately leaves out (with 0, 1, I, L, U).
    typeInto(codeInput(element), 'OOOOOOOO')
    submit(element)

    expect(landingSearch(element)).toBe(null)
    expect(errorText(element)).toContain('session alphabet')
  })

  it('refuses an empty submission', () => {
    const element = renderEntry()

    submit(element)

    expect(landingSearch(element)).toBe(null)
    expect(errorText(element)).toContain('exactly 8 characters')
  })

  it('clears the error once the user starts fixing the code', () => {
    const element = renderEntry()

    typeInto(codeInput(element), 'nope')
    submit(element)
    expect(errorText(element)).not.toBe(null)

    typeInto(codeInput(element), VALID_CODE)
    expect(errorText(element)).toBe(null)
  })
})
