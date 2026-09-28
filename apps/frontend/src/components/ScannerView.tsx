import { useState } from 'react'
import {
  X,
  Lock,
  Keyboard,
  Scan,
  ArrowRight,
} from 'lucide-react'
import type { LibraryFile } from '../lib/library'
import { QRScanner } from './QRScanner'

export interface ScannerViewProps {
  selectedFile?: LibraryFile | null
  onScan: (code: string) => void
  onCancel: () => void
}

export function ScannerView({
  selectedFile,
  onScan,
  onCancel,
}: ScannerViewProps) {
  const [manualCode, setManualCode] = useState('')

  const handleManualSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!manualCode.trim()) return
    onScan(manualCode.trim().toUpperCase())
  }

  const hasLocked = selectedFile?.blocks?.some((b) => b.type === 'locked' || b.isLocked)

  return (
    <div className="flex flex-col min-h-screen bg-[#0B0F19] text-white select-none">
      {/* Top Header */}
      <header className="px-5 py-4 flex items-center justify-between z-20 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Scan className="w-4 h-4 text-[#38BDF8]" />
          <span className="font-display font-semibold text-sm tracking-wide text-white">
            Optical Transceiver
          </span>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="scanner__cancel p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors tactile-btn cursor-pointer"
          aria-label="Cancel scanning"
        >
          <X className="w-5 h-5" />
        </button>
      </header>

      {/* Main Viewfinder Area */}
      <main className="flex-1 flex flex-col items-center justify-between px-5 py-4 max-w-md mx-auto w-full">
        {/* Pre-selected File Summary Banner */}
        {selectedFile ? (
          <div className="w-full bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 mb-4 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono text-[#38BDF8] flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#38BDF8] animate-pulse" />
                Payload Ready
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                {selectedFile.blocks?.length || 0} blocks
              </span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="font-semibold text-sm text-slate-100 truncate">
                {selectedFile.name}
              </span>
              {hasLocked && (
                <span className="inline-flex items-center gap-1 text-[10px] text-orange-400 bg-orange-950/60 border border-orange-800 px-1.5 py-0.5 rounded font-mono">
                  <Lock className="w-2.5 h-2.5" />
                  Encrypted
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="w-full text-center py-2">
            <p className="text-xs text-slate-400 font-mono">
              Ready to pair transmission channel
            </p>
          </div>
        )}

        {/* Optical Camera Viewfinder */}
        <div className="relative w-64 h-64 sm:w-72 sm:h-72 my-auto flex items-center justify-center">
          <div className="absolute inset-0 rounded-2xl border border-slate-700/60 bg-slate-900/40 backdrop-blur-xs overflow-hidden">
            {/* Viewfinder crosshairs */}
            <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 h-[1px] bg-sky-500/20" />
            <div className="absolute inset-y-4 left-1/2 -translate-x-1/2 w-[1px] bg-sky-500/20" />

            {/* Sweep laser line animation */}
            <div className="absolute inset-x-2 h-0.5 bg-gradient-to-r from-transparent via-[#38BDF8] to-transparent shadow-[0_0_14px_#38BDF8] animate-scan-sweep pointer-events-none z-10" />

            {/* Reticle brackets (4 corners) */}
            <div className="absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 border-[#38BDF8] z-10" />
            <div className="absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 border-[#38BDF8] z-10" />
            <div className="absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 border-[#38BDF8] z-10" />
            <div className="absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 border-[#38BDF8] z-10" />

            {/* Real Camera Scanner */}
            <div className="w-full h-full flex items-center justify-center overflow-hidden">
              <QRScanner onScan={onScan} onCancel={onCancel} />
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-400 text-center my-3 max-w-[280px]">
          Point viewfinder at the QR code displayed on the other device.
        </p>

        {/* Fallback Pairing Code Manual Input */}
        <div className="w-full pt-3 pb-6 border-t border-slate-800">
          <form onSubmit={handleManualSubmit} className="manual-code space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
              <span className="flex items-center gap-1.5">
                <Keyboard className="w-3.5 h-3.5 text-slate-500" />
                Manual Pairing Fallback
              </span>
              <span>Code format: 8 characters</span>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="e.g. ABCDEFGH"
                className="manual-code__input flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-base sm:text-xs font-mono uppercase tracking-wider text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
              />
              <button
                type="submit"
                disabled={!manualCode.trim()}
                className="manual-code__submit px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-40 text-xs font-semibold rounded-lg border border-slate-700 flex items-center gap-1.5 tactile-btn cursor-pointer"
              >
                <span>Pair</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  )
}
