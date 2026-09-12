/**
 * Unit tests for the pure helpers exported by useSession (PLAN.md §8).
 *
 * Only the pure functions are exercised: the hook itself is integration behaviour,
 * and a React/DOM harness would test the framework rather than this logic.
 */

import {
  PEER_REJOINED_REASON,
  deriveSessionMaterial,
  describeError,
  describeSessionStatus,
  nextPhaseForConfirmations,
  parseNewSessionResponse,
} from './useSession'
import { exportPublicKey, generateKeypair, toBase64 } from '../lib/crypto'
import { decodeFrame, encodeFrame } from '../lib/webrtc'
import { useSessionStore } from '../store/sessionStore'

const TEST_SESSION_CODE = 'A7X3K9P2'

describe('parseNewSessionResponse', () => {
  it('accepts a session code without TURN credentials', () => {
    expect(parseNewSessionResponse({ code: 'A7X3K9P2' })).toEqual({ code: 'A7X3K9P2' })
  })

  it('keeps TURN credentials when both fields are present', () => {
    const parsed = parseNewSessionResponse({
      code: 'A7X3K9P2',
      turnCredentials: { username: 'user', credential: 'cred' },
    })

    expect(parsed).toEqual({
      code: 'A7X3K9P2',
      turnCredentials: { username: 'user', credential: 'cred' },
    })
  })

  it('drops a malformed TURN payload instead of failing the whole session', () => {
    expect(parseNewSessionResponse({ code: 'A7X3K9P2', turnCredentials: { username: 'user' } })).toEqual(
      { code: 'A7X3K9P2' },
    )
    expect(parseNewSessionResponse({ code: 'A7X3K9P2', turnCredentials: 'nope' })).toEqual({
      code: 'A7X3K9P2',
    })
  })

  it('rejects a payload that carries no usable code', () => {
    expect(() => parseNewSessionResponse(null)).toThrow(/unexpected payload/)
    expect(() => parseNewSessionResponse({ code: '' })).toThrow(/without a code/)
    expect(() => parseNewSessionResponse({ code: 42 })).toThrow(/without a code/)
  })
})

describe('describeError', () => {
  it('uses the Error message when there is one', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('falls back to a non-blank string and then to a generic message', () => {
    expect(describeError('plain text')).toBe('plain text')
    expect(describeError('   ')).toBe('Something went wrong starting the session')
    expect(describeError(new Error(''))).toBe('Something went wrong starting the session')
    expect(describeError(null)).toBe('Something went wrong starting the session')
  })
})

describe('describeSessionStatus', () => {
  it('reports an error above every other state', () => {
    expect(describeSessionStatus('idle', 'new', 'nope')).toEqual({ label: 'Error', tone: 'error' })
  })

  it('reports connected once the session is active or the peer connects', () => {
    expect(describeSessionStatus('active', 'new', null)).toEqual({ label: 'Connected', tone: 'ok' })
    expect(describeSessionStatus('connecting', 'connected', null)).toEqual({
      label: 'Connected',
      tone: 'ok',
    })
  })

  it('reports the ended session as idle', () => {
    expect(describeSessionStatus('ended', 'closed', null)).toEqual({
      label: 'Session ended',
      tone: 'idle',
    })
  })

  it('maps a failed or lost connection to an error or a warning', () => {
    expect(describeSessionStatus('connecting', 'failed', null)).toEqual({
      label: 'Connection failed',
      tone: 'error',
    })
    expect(describeSessionStatus('connecting', 'disconnected', null)).toEqual({
      label: 'Connection lost',
      tone: 'warn',
    })
  })

  it('is still connecting otherwise', () => {
    expect(describeSessionStatus('connecting', 'new', null)).toEqual({
      label: 'Connecting…',
      tone: 'warn',
    })
  })
})

/**
 * ORCHESTRATION.md D4: the host ends the session when the other device re-joins.
 *
 * The hook's `pubkey` branch has no React harness here (see the file header), so the
 * path under test is the one it uses: the exported reason ends up in the store's
 * `errorMessage` via `endSession`, which Session.tsx renders as the Error panel.
 */
describe('a peer that re-joined after the offer (D4)', () => {
  afterEach(() => {
    useSessionStore.getState().reset()
  })

  it('ends the session and tells the user the other device reconnected', () => {
    useSessionStore.getState().startConnecting('host', 'A7X3K9P2')
    useSessionStore.getState().endSession(PEER_REJOINED_REASON)

    const state = useSessionStore.getState()
    expect(state.phase).toBe('ended')
    expect(state.errorMessage).toBe(PEER_REJOINED_REASON)
    expect(state.connectionState).toBe('new')
    expect(PEER_REJOINED_REASON).toMatch(/reconnected/i)
    expect(PEER_REJOINED_REASON).toMatch(/new session/i)
  })

  it('surfaces as an Error status rather than a silent "Connecting…"', () => {
    useSessionStore.getState().startConnecting('host', 'A7X3K9P2')
    useSessionStore.getState().endSession(PEER_REJOINED_REASON)

    const { phase, connectionState, errorMessage } = useSessionStore.getState()

    expect(describeSessionStatus(phase, connectionState, errorMessage)).toEqual({
      label: 'Error',
      tone: 'error',
    })
  })
})

describe('deriveSessionMaterial (PLAN.md §11.1–§11.3, §11.6)', () => {
  async function publicKeyBase64(pair: CryptoKeyPair): Promise<string> {
    return toBase64(await exportPublicKey(pair.publicKey))
  }

  it('gives both devices the same session key and the same three words', async () => {
    const hostKeys = await generateKeypair()
    const guestKeys = await generateKeypair()

    // Only the public halves travel, exactly as the join/pubkey messages carry them.
    const hostMaterial = await deriveSessionMaterial(
      hostKeys.privateKey,
      await publicKeyBase64(guestKeys),
      TEST_SESSION_CODE,
    )
    const guestMaterial = await deriveSessionMaterial(
      guestKeys.privateKey,
      await publicKeyBase64(hostKeys),
      TEST_SESSION_CODE,
    )

    expect(hostMaterial.phrase).toEqual(guestMaterial.phrase)
    expect(hostMaterial.phrase).toHaveLength(3)

    // The two session keys are the same key: a frame from one peer decrypts on the
    // other. (The CryptoKey itself is non-extractable, so this is the only way to
    // compare them — which is also the property that matters.)
    const frame = { t: 'phrase-confirm' } as const
    const envelope = await encodeFrame(frame, hostMaterial.sessionKey)
    await expect(decodeFrame(envelope, guestMaterial.sessionKey)).resolves.toEqual(frame)
  })

  it('derives a different session key for a different session code', async () => {
    const keys = await generateKeypair()
    const peerKeys = await generateKeypair()
    const peerPublic = await publicKeyBase64(peerKeys)

    const first = await deriveSessionMaterial(keys.privateKey, peerPublic, TEST_SESSION_CODE)
    const second = await deriveSessionMaterial(keys.privateKey, peerPublic, 'B2Y4M6Q8')

    const envelope = await encodeFrame({ t: 'session-end' }, first.sessionKey)
    // A different HKDF salt is a different key: the tag no longer verifies.
    await expect(decodeFrame(envelope, second.sessionKey)).rejects.toThrow()
  })

  it('returns only the key and the phrase — never the shared secret', async () => {
    const keys = await generateKeypair()
    const peerKeys = await generateKeypair()

    const material = await deriveSessionMaterial(
      keys.privateKey,
      await publicKeyBase64(peerKeys),
      TEST_SESSION_CODE,
    )

    expect(Object.keys(material).sort()).toEqual(['phrase', 'sessionKey'])
    expect(material.sessionKey.extractable).toBe(false)
    expect(material.sessionKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
  })

  it('rejects a peer public key that is empty or malformed', async () => {
    const keys = await generateKeypair()

    // Phase 1 sent an empty publicKey; Phase 2 must not silently accept it, because
    // a session without a peer key cannot be encrypted.
    await expect(deriveSessionMaterial(keys.privateKey, '', TEST_SESSION_CODE)).rejects.toThrow()
    await expect(deriveSessionMaterial(keys.privateKey, 'not base64!!', TEST_SESSION_CODE)).rejects.toThrow()
    await expect(
      deriveSessionMaterial(keys.privateKey, toBase64(new Uint8Array([1, 2, 3])), TEST_SESSION_CODE),
    ).rejects.toThrow()
  })
})

describe('nextPhaseForConfirmations (PLAN.md §8 Phase 2)', () => {
  it('holds the session in pairing until BOTH devices confirm', () => {
    expect(nextPhaseForConfirmations('pairing', false, false)).toBe('pairing')
    expect(nextPhaseForConfirmations('pairing', true, false)).toBe('pairing')
    expect(nextPhaseForConfirmations('pairing', false, true)).toBe('pairing')
  })

  it('advances to active only once both flags are set', () => {
    expect(nextPhaseForConfirmations('pairing', true, true)).toBe('active')
  })

  it('never leaves a phase that is not pairing', () => {
    expect(nextPhaseForConfirmations('connecting', true, true)).toBe('connecting')
    expect(nextPhaseForConfirmations('idle', true, true)).toBe('idle')
    expect(nextPhaseForConfirmations('ended', true, true)).toBe('ended')
    expect(nextPhaseForConfirmations('active', true, true)).toBe('active')
  })
})
