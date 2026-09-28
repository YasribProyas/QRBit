/**
 * Manual session-code entry (PLAN.md §8's typed fallback, §16 Phase 6's "Manual code entry
 * fallback UI").
 *
 * Upgraded with Mantine UI: prominent, large monospace code field with centered tracking,
 * matching-height submit button, and accessible error validation.
 */

import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Button, Text, TextInput } from '@mantine/core'
import { IconArrowRight } from '@tabler/icons-react'

import { SESSION_CODE_LENGTH, isValidSessionCode } from '../hooks/useSession'
import { WithMantine } from './common/WithMantine'

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

function ManualCodeEntryForm() {
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
    <Box component="form" className="manual-code" onSubmit={join} style={{ width: '100%' }}>
      <Text
        component="label"
        className="manual-code__label"
        htmlFor={inputId}
        size="sm"
        fw={500}
        c="dimmed"
        mb={6}
        display="block"
      >
        Have a code instead? Type it in
      </Text>
      <div
        className="manual-code__row"
        style={{ display: 'flex', gap: '0.75rem', alignItems: 'stretch', width: '100%' }}
      >
        <TextInput
          id={inputId}
          size="md"
          classNames={{ input: 'manual-code__input' }}
          style={{ flex: 1, minWidth: 0 }}
          styles={{
            root: { flex: 1 },
            wrapper: { height: '48px' },
            input: {
              height: '48px',
              fontFamily:
                '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              letterSpacing: '0.18em',
              fontSize: '1.2rem',
              textAlign: 'center',
              textTransform: 'uppercase',
              fontWeight: 700,
            },
          }}
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
        />
        <Button
          type="submit"
          size="md"
          className="button manual-code__submit"
          style={{
            width: 'auto',
            minWidth: '130px',
            height: '48px',
            flexShrink: 0,
            background: 'var(--accent)',
            fontWeight: 650,
          }}
          rightSection={<IconArrowRight size={18} />}
        >
          Join session
        </Button>
      </div>
      {error !== null ? (
        <Text
          role="alert"
          className="manual-code__error item-error"
          c="red.4"
          size="xs"
          mt={6}
          fw={500}
        >
          {error}
        </Text>
      ) : null}
    </Box>
  )
}

export function ManualCodeEntry() {
  return (
    <WithMantine>
      <ManualCodeEntryForm />
    </WithMantine>
  )
}
