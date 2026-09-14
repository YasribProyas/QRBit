/**
 * Manual session-code entry (PLAN.md §8's typed fallback, §16 Phase 6's "Manual code entry
 * fallback UI").
 *
 * The happy path is a scan: the QR encodes the full `/session?code=XXXXXXXX` URL, so a
 * camera app opens the session directly and nothing here is needed. This form exists for
 * the device that cannot scan — an old phone, a locked-down browser, a camera that will
 * not focus — and it does the one thing a scanner cannot: it turns a code the user read
 * off the other screen into the same `/session?code=X` navigation (PLAN.md §8's guest
 * role).
 *
 * The code is validated HERE, against the Phase 1 alphabet, before it becomes a
 * navigation. The worker validates the same rule server-side, but a client that skipped it
 * would send a doomed request and blame the server for a typo the user could have been
 * told about. A scanned payload needs no such trust: it is decoded input from a camera
 * that can see anything.
 *
 * CASE: the field uppercases as you type, so the exact string the worker issued is what
 * gets submitted — the worker does no normalisation, so a lower-case code would 400. That
 * is the ONLY thing done to the input: length and alphabet are checked on submit and never
 * repaired, because "helpfully" turning a 0 into an O would send the user to a session
 * that does not exist.
 */

import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { SESSION_CODE_LENGTH, isValidSessionCode } from '../hooks/useSession'

/** Why a code cannot be used, in the words the person typing it needs to hear. */
function validationError(code: string): string | null {
  if (code.length !== SESSION_CODE_LENGTH) {
    return `A session code is exactly ${SESSION_CODE_LENGTH} characters.`
  }
  if (!isValidSessionCode(code)) {
    return 'That code uses a character the session alphabet leaves out — it has no 0, 1, I, L, O or U.'
  }
  return null
}

export function ManualCodeEntry() {
  const navigate = useNavigate()
  const inputId = useId()

  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const join = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    const problem = validationError(code)
    if (problem !== null) {
      setError(problem)
      return
    }

    setError(null)
    navigate(`/session?code=${encodeURIComponent(code)}`)
  }

  return (
    <form className="manual-code" onSubmit={join}>
      <label className="manual-code__label" htmlFor={inputId}>
        Have a code instead? Type it in
      </label>
      <div className="manual-code__row">
        <input
          id={inputId}
          className="manual-code__input"
          value={code}
          onChange={(event) => {
            // The one normalisation: the worker matches the code EXACTLY, so the field
            // produces the exact upper-case form it expects while the user types.
            setCode(event.target.value.toUpperCase())
            if (error !== null) setError(null)
          }}
          placeholder="A7X3K9P2"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={error !== null ? `${inputId}-error` : undefined}
        />
        <button type="submit" className="button manual-code__join">
          Join session
        </button>
      </div>
      {error !== null ? (
        <p className="manual-code__error item-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
