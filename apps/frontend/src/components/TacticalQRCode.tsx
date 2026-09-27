import { useEffect, useRef, useState } from 'react'
import { toCanvas } from 'qrcode'
import { RefreshCw, Copy, Check, Zap } from 'lucide-react'
import { buildSessionUrl } from '../config'

export interface TacticalQRCodeProps {
  pairingCode?: string
  sessionUrl?: string
  onRegenerate?: () => void
  size?: number
  showLabel?: boolean
  interactive?: boolean
}

export function TacticalQRCode({
  pairingCode = 'QRB-884-219',
  sessionUrl,
  onRegenerate,
  size = 200,
  showLabel = true,
  interactive = true,
}: TacticalQRCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [isSpinning, setIsSpinning] = useState(false)

  const payload = sessionUrl || (pairingCode ? buildSessionUrl(pairingCode) : `qrbit://${pairingCode}`)

  useEffect(() => {
    if (canvasRef.current) {
      toCanvas(canvasRef.current, payload, {
        width: size,
        margin: 1,
        color: {
          dark: '#0F172A',
          light: '#FFFFFF',
        },
        errorCorrectionLevel: 'H',
      }).catch((err) => {
        // Defensive log/catch
        console.error('TacticalQRCode render failed:', err)
      })
    }
  }, [payload, size])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sessionUrl || pairingCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Ignore clipboard write failure
    }
  }

  const handleRefresh = () => {
    setIsSpinning(true)
    if (onRegenerate) onRegenerate()
    setTimeout(() => setIsSpinning(false), 450)
  }

  return (
    <div className="flex flex-col items-center">
      {/* Optical Precision Target Frame */}
      <div className="relative p-5 bg-white rounded-xl border border-[#D1D9E4] shadow-xs">
        {/* Optical alignment ticks at 4 corners */}
        <div className="absolute top-1.5 left-1.5 w-2.5 h-2.5 border-t-2 border-l-2 border-[#1D4ED8]" />
        <div className="absolute top-1.5 right-1.5 w-2.5 h-2.5 border-t-2 border-r-2 border-[#1D4ED8]" />
        <div className="absolute bottom-1.5 left-1.5 w-2.5 h-2.5 border-b-2 border-l-2 border-[#1D4ED8]" />
        <div className="absolute bottom-1.5 right-1.5 w-2.5 h-2.5 border-b-2 border-r-2 border-[#1D4ED8]" />

        {/* Center reticle crosshair guides */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-[#1D4ED8]/10 pointer-events-none" />
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1px] bg-[#1D4ED8]/10 pointer-events-none" />

        <canvas
          ref={canvasRef}
          className="rounded-md transition-opacity duration-200"
          style={{ width: size, height: size }}
          width={size}
          height={size}
        />

        {/* Micro optical badge in center of QR */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-md bg-white border border-[#D1D9E4] shadow-xs flex items-center justify-center pointer-events-none">
          <div className="w-4 h-4 rounded-sm bg-[#1D4ED8] flex items-center justify-center text-white">
            <Zap className="w-2.5 h-2.5" />
          </div>
        </div>
      </div>

      {showLabel && (
        <div className="mt-3.5 text-center flex flex-col items-center">
          <p className="text-[13px] text-[#5B6B82] max-w-[280px] leading-relaxed">
            Scan with any device's camera to establish an air-gapped peer transfer channel.
          </p>

          <div className="mt-2.5 flex items-center gap-2">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-[#D1D9E4] rounded-md font-mono text-[13px] text-[#0F172A] font-semibold shadow-2xs">
              <span className="w-1.5 h-1.5 rounded-full bg-[#0F766E] animate-pulse" />
              {pairingCode}
            </div>

            {interactive && (
              <>
                <button
                  type="button"
                  onClick={handleCopy}
                  title="Copy pairing code or link"
                  className="p-1.5 text-[#5B6B82] hover:text-[#0F172A] bg-white rounded-md border border-[#D1D9E4] tactile-btn shadow-2xs cursor-pointer"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-[#0F766E]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>

                {onRegenerate && (
                  <button
                    type="button"
                    onClick={handleRefresh}
                    title="Generate new pairing code"
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-[#1D4ED8] bg-white hover:bg-blue-50 border border-blue-200 rounded-md tactile-btn shadow-2xs cursor-pointer"
                  >
                    <RefreshCw
                      className="w-3 h-3 transition-transform"
                      style={{
                        transform: isSpinning ? 'rotate(180deg)' : 'rotate(0deg)',
                        transitionDuration: '400ms',
                        transitionTimingFunction: 'var(--ease-out)',
                      }}
                    />
                    <span>Regenerate</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
