/**
 * Manual session-code entry (PLAN.md §8's typed fallback, §16 Phase 6's "Manual code entry
 * fallback UI").
 *
 * Upgraded with Mantine UI: sleek monospace input field with validation,
 * inline action button, and accessible error message.
 */

import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box, Button, Group, Text, TextInput } from '@mantine/core'
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
    <Box component="form" className="manual-code" onSubmit={join}>
      <Text
        component="label"
        className="manual-code__label"
        htmlFor={inputId}
        size="sm"
        fw={500}
        c="dimmed"
        mb={4}
        display="block"
      >
        Have a code instead? Type it in
      </Text>
      <div className="manual-code__row">
        <Group gap="xs" align="flex-start" wrap="nowrap" style={{ flex: 1 }}>
          <TextInput
            id={inputId}
            classNames={{ input: 'manual-code__input' }}
            styles={{
              input: {
                fontFamily:
                  '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
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
            style={{ flex: 1 }}
          />
          <Button
            type="submit"
            className="button manual-code__submit"
            rightSection={<IconArrowRight size={16} />}
          >
            Join session
          </Button>
        </Group>
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
