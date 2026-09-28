import { useState } from 'react'
import {
  ShieldCheck,
  Check,
  X,
  Info,
} from 'lucide-react'
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
  peerName?: string
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
  peerName = 'Peer Device (Air-Gap Handshake)',
}: SafetyPhraseViewProps) {
  const sender = isSender ?? (role !== undefined && role !== null ? role === 'guest' : true)
  const [hasConfirmedLocal, setHasConfirmedLocal] = useState(confirmed)

  const handleConfirmClick = () => {
    setHasConfirmedLocal(true)
    onConfirm()
  }

  return (
    <div
      className="safety-phrase fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#EEF2F6] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="safety-phrase-instruction"
    >
      <div className="safety-phrase__panel flex flex-col min-h-full max-w-lg mx-auto w-full py-8 justify-between">
        {/* Top Security Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-50 text-[#1D4ED8] border border-blue-200 shadow-2xs mb-2">
            <ShieldCheck className="w-6 h-6" />
          </div>

          <h2 id="safety-phrase-instruction" className="safety-phrase__instruction font-display font-bold text-2xl text-[#0F172A] tracking-tight">
            Verify Safety Phrase
          </h2>
          <p className="text-xs text-[#5B6B82] max-w-xs mx-auto leading-relaxed">
            Before transferring any data blocks, compare the three verification words with the other screen.
          </p>
        </div>

        {/* Center 3-Word Prominent Display */}
        <div className="my-6">
          <div className="bg-white rounded-2xl border-2 border-[#1D4ED8]/30 shadow-lg p-6 text-center space-y-4 relative overflow-hidden">
            {/* Subtle security mesh watermark */}
            <div className="text-[11px] font-mono uppercase tracking-widest text-[#1D4ED8] font-semibold flex items-center justify-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1D4ED8] animate-ping" />
              Air-Gap Handshake Phrase
            </div>

            {/* 3 WORDS DISPLAYED PROMINENTLY */}
            <ul className="safety-phrase__words flex flex-col sm:flex-row items-center justify-center gap-3 py-3 list-none m-0 p-0">
              {phrase.map((word, i) => (
                <li
                  key={i}
                  className="safety-phrase__word w-full sm:w-auto px-4 py-2.5 bg-[#EEF2F6] border border-[#D1D9E4] rounded-lg font-mono font-bold text-lg sm:text-xl text-[#0F172A] tracking-wider shadow-2xs uppercase"
                >
                  {word}
                </li>
              ))}
            </ul>

            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-left flex items-start gap-2.5">
              <Info className="w-4 h-4 text-[#1D4ED8] shrink-0 mt-0.5" />
              <p className="text-xs text-slate-600 leading-normal">
                If the words displayed on <strong className="text-slate-900">{peerName}</strong> are not identical to these, an optical or network interception attempt has occurred. Abort immediately.
              </p>
            </div>
          </div>

          {/* Peer connection badge & status */}
          <div className="safety-phrase__status mt-4 flex flex-col items-center justify-center gap-2 text-xs text-[#5B6B82]" role="status" aria-live="polite">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>Connected to:</span>
              <span className="font-semibold text-slate-800">{peerName}</span>
            </div>

            {sender ? (
              <p className="safety-phrase__check flex items-center gap-2" data-state={confirmed || hasConfirmedLocal ? 'confirmed' : 'pending'}>
                <span className="safety-phrase__check-label font-semibold">This device:</span>
                <span>{confirmed || hasConfirmedLocal ? 'confirmed ✓' : 'not confirmed yet'}</span>
              </p>
            ) : (
              <p className="safety-phrase__check flex items-center gap-2" data-state={peerConfirmed ? 'confirmed' : 'pending'}>
                <span className="safety-phrase__check-label font-semibold">Sender:</span>
                <span>{peerConfirmed ? 'confirmed ✓' : 'waiting for confirmation…'}</span>
              </p>
            )}
          </div>
        </div>

        {/* Action Buttons: Confirm Match vs Abort Session */}
        <div className="safety-phrase__actions space-y-3 pt-4 border-t border-[#D1D9E4]">
          {sender ? (
            <button
              type="button"
              onClick={handleConfirmClick}
              disabled={busy || confirmed || hasConfirmedLocal}
              className="button safety-phrase__confirm w-full py-3.5 bg-[#1D4ED8] hover:bg-[#1E40AF] text-white rounded-xl font-display font-semibold text-sm shadow-sm flex items-center justify-center gap-2 transition-all tactile-btn cursor-pointer disabled:opacity-50"
            >
              Confirmed
            </button>
          ) : null}

          <button
            type="button"
            onClick={onAbort}
            disabled={busy}
            className="button safety-phrase__abort w-full py-2.5 bg-white hover:bg-red-50 text-slate-600 hover:text-red-600 border border-slate-200 hover:border-red-200 rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition-colors tactile-btn cursor-pointer"
          >
            Abort session
          </button>

          <p className="safety-phrase__footnote text-center text-xs text-[#5B6B82] pt-1">
            {sender
              ? confirmed || hasConfirmedLocal
                ? 'Confirmed — starting the session…'
                : 'The session starts once you confirm the words match.'
              : peerConfirmed
                ? 'Sender confirmed — starting the session…'
                : 'Waiting for the sender to confirm the safety phrase.'}
          </p>
        </div>
      </div>
    </div>
  )
}
