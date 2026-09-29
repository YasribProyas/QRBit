/**
 * Manual session-code entry (PLAN.md §8's typed fallback, §16 Phase 6's "Manual code entry
 * fallback UI").
 *
 * This is the ONE typed-code form in the app. `HomeView` used to carry a second, inline copy
 * of the same thing (label + input + submit, no validation), which meant the panel's fallback
 * and the tested component were different code paths — the failure shape D16.0 describes, where
 * a redesign keeps an implementation alive that nothing routes through. It is mounted here
 * instead, and the duplicate is gone.
 *
 * The form's whole job is untrusted-input handling: the code a user types is validated against
 * the Phase 1 alphabet BEFORE anything is asked of the network, so a typo cannot become a
 * request the worker rejects with a 400, and an empty or malformed submission never navigates.
 *
 * Routing is the caller's: with `onSubmit` the host surface decides what a code means (Home
 * clears its send queue and navigates through its own handler); without one this component
 * navigates to `/session?code=…` itself. The 48px field and 48px submit are DESIGN.md's mobile
 * typing target — the code is typed on a phone, held in the hand that is not holding the other
 * device.
 */

import { useId, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Button, Group, Text, TextInput } from '@mantine/core'
import { IconArrowRight } from '@tabler/icons-react'

import { SESSION_CODE_LENGTH, isValidSessionCode } from '../hooks/useSession'
import { WithMantine } from './common/WithMantine'

export interface ManualCodeEntryProps {
  /**
   * A validated, upper-cased code. When supplied, the caller owns what happens next and this
   * component does not navigate.
   */
  onSubmit?: (code: string) => void
}

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

/**
 * The code field's own type.
 *
 * The Data role is 13px (DESIGN.md), which is below the 16px floor `styles.css` sets on every
 * input to stop mobile browsers zooming the page when a field is focused. A code is the one
 * value a person reads back off the other screen, so it keeps the mono family, the tabular
 * figures and the letter-spacing, and takes the input floor for size.
 */
const CODE_INPUT_STYLE = {
  fontFamily: 'var(--qrbit-font-mono)',
  fontSize: '16px',
  fontWeight: 600,
  lineHeight: '48px',
  letterSpacing: '0.18em',
  textAlign: 'center',
  textTransform: 'uppercase',
  height: '48px',
} as const satisfies CSSProperties

function ManualCodeEntryForm({ onSubmit }: ManualCodeEntryProps) {
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
    if (onSubmit) {
      onSubmit(code)
      return
    }
    navigate(`/session?code=${encodeURIComponent(code)}`)
  }

  return (
    <Box component="form" className="manual-code" onSubmit={join} style={{ width: '100%' }}>
      <Text
        component="label"
        className="manual-code__label qrbit-text-label"
        htmlFor={inputId}
        c="dimmed"
        mb="xs"
        display="block"
      >
        Have a code instead? Type it in
      </Text>
      <Group align="stretch" gap="sm" wrap="nowrap" className="manual-code__row">
        <TextInput
          id={inputId}
          size="md"
          className="min-w-0 flex-1"
          // The input element carries the class the pairing tests select, so the styling
          // hook and the test hook are the same node.
          classNames={{ input: 'manual-code__input' }}
          styles={{ input: CODE_INPUT_STYLE }}
          value={code}
          onChange={(event) => {
            setCode(event.target.value.toUpperCase())
            if (error !== null) setError(null)
          }}
          placeholder="A7X3K9P2"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={SESSION_CODE_LENGTH}
          aria-invalid={error !== null}
          inputMode="text"
        />
        <Button
          type="submit"
          className="manual-code__submit"
          // Matches the field's 48px target; DESIGN.md's primary fill and pressed colour.
          size="md"
          color="signal"
          style={{ height: '48px', flexShrink: 0 }}
          rightSection={<IconArrowRight size={18} aria-hidden="true" />}
        >
          Join session
        </Button>
      </Group>
      {error !== null ? (
        <Text
          component="p"
          role="alert"
          className="manual-code__error item-error qrbit-text-body-secondary"
          c="danger"
          mt="xs"
        >
          {error}
        </Text>
      ) : null}
    </Box>
  )
}

export function ManualCodeEntry(props: ManualCodeEntryProps) {
  return (
    <WithMantine>
      <ManualCodeEntryForm {...props} />
    </WithMantine>
  )
}
