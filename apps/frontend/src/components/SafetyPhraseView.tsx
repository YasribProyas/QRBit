/**
 * The safety-phrase gate (PLAN.md §8 Phase 2; ORCHESTRATION D14).
 *
 * This is the product's one security moment, and it is the only place in the app where
 * colour is allowed to shout. The design follows from that, not from decoration:
 *
 *  - the three words are the largest and highest-contrast thing on the screen — they are the
 *    comparison, so nothing competes with them (`.safety-phrase__word` in `styles.css` sizes
 *    them with `clamp(1.625rem, 11vw, 3rem)` in the mono face, on a sunken well);
 *  - the sender's confirmation is the primary action, and the receiver gets no gating button
 *    at all (D14) — the copy names who is confirming;
 *  - abort is quiet (`variant="subtle"`, fault red) but always reachable and always enabled
 *    unless a confirmation is in flight.
 *
 * What this surface is NOT allowed to do is claim a relationship the code has not established.
 * The previous revision printed "Connected to: Peer Device (Air-Gap Handshake)" — a peer name
 * nothing in the app produces — with an emerald dot asserting the link. The words themselves
 * are the peer evidence this protocol has, so that is what is shown, plus the two
 * confirmation flags the session actually reports.
 */

import { useState } from 'react'
import { Button, Group, Stack, Text, Title } from '@mantine/core'
import { IconShieldCheck } from '@tabler/icons-react'

import type { SessionRole } from '../lib/signaling'

export interface SafetyPhraseViewProps {
  phrase: readonly [string, string, string]
  confirmed: boolean
  peerConfirmed: boolean
  onConfirm: () => void
  onAbort: () => void
  busy?: boolean
  isSender?: boolean
  role?: SessionRole | null
  /**
   * The peer's own name, if the caller has one. There is no default: a name this component
   * invented would be an assertion about who is on the other end, which is exactly the claim
   * the phrase exists to test.
   */
  peerName?: string | null
}

export function SafetyPhraseView({
  phrase,
  confirmed,
  peerConfirmed,
  onConfirm,
  onAbort,
  busy = false,
  isSender,
  role,
  peerName = null,
}: SafetyPhraseViewProps) {
  /** D14: the sender (the device that opened the session as guest) is the party that confirms. */
  const sender = isSender ?? (role !== undefined && role !== null ? role === 'guest' : true)
  const [hasConfirmedLocal, setHasConfirmedLocal] = useState(confirmed)
  const confirmedHere = confirmed || hasConfirmedLocal

  const handleConfirmClick = (): void => {
    setHasConfirmedLocal(true)
    onConfirm()
  }

  return (
    <div
      className="safety-phrase"
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-phrase-instruction"
    >
      <div className="safety-phrase__panel">
        <Stack gap="sm" align="center">
          <Group gap="xs" wrap="nowrap" justify="center">
            <IconShieldCheck size={20} aria-hidden="true" style={{ color: 'var(--qrbit-ink-secondary)' }} />
            {/* The heading carries its own weight: no kicker line above the words. */}
            <Title order={1} id="safety-phrase-instruction" className="qrbit-text-headline">
              Check these three words
            </Title>
          </Group>
          <Text className="qrbit-text-body-secondary" c="dimmed" maw="44ch" ta="center">
            They come from the key exchange, so they match only if the same session is on both
            screens.
          </Text>
        </Stack>

        {/*
           The comparison itself. `.safety-phrase__word` is the design system's largest type;
           there is deliberately nothing else on this surface at that size, and no card inside
           the card.
        */}
        <ul className="safety-phrase__words">
          {phrase.map((word, index) => (
            <li className="safety-phrase__word" key={index}>
              {word}
            </li>
          ))}
        </ul>

        <Stack gap="xs" className="safety-phrase__status" role="status" aria-live="polite">
          <Text className="qrbit-text-body-secondary" c="dimmed" ta="center">
            {peerName === null
              ? 'Compare these with the words on the other device’s screen.'
              : `Compare these with the words on ${peerName}.`}
          </Text>
          <Text className="qrbit-text-body-secondary" c="danger" ta="center">
            If they differ, do not continue. Abort and start a new session.
          </Text>

          {sender ? (
            <p className="safety-phrase__check" data-state={confirmedHere ? 'confirmed' : 'pending'}>
              <span className="safety-phrase__check-label">This device:</span>
              <span>{confirmedHere ? 'confirmed' : 'not confirmed yet'}</span>
            </p>
          ) : (
            <p className="safety-phrase__check" data-state={peerConfirmed ? 'confirmed' : 'pending'}>
              <span className="safety-phrase__check-label">Sender:</span>
              <span>{peerConfirmed ? 'confirmed' : 'waiting for confirmation…'}</span>
            </p>
          )}
        </Stack>

        <Stack gap="sm" className="safety-phrase__actions">
          {sender ? (
            <Button
              color="signal"
              size="md"
              w="100%"
              disabled={busy || confirmedHere}
              // The visible label stays the one the page-level tests select; the accessible
              // name says what pressing it decides.
              aria-label="Confirm that these words match the other device"
              onClick={handleConfirmClick}
            >
              Confirmed
            </Button>
          ) : null}

          <Button
            variant="subtle"
            color="danger"
            size="sm"
            w="100%"
            disabled={busy}
            onClick={onAbort}
          >
            Abort session
          </Button>

          {/* The panel centres its own text; the footnote adds no alignment of its own. */}
          <p className="safety-phrase__footnote qrbit-text-body-secondary">
            {sender
              ? confirmedHere
                ? 'Confirmed — starting the session…'
                : 'The session starts once you confirm the words match.'
              : peerConfirmed
                ? 'Sender confirmed — starting the session…'
                : 'Waiting for the sender to confirm the safety phrase.'}
          </p>
        </Stack>
      </div>
    </div>
  )
}
