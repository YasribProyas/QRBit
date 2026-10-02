import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { HomeView } from '../components/HomeView'
import { FileEditView } from '../components/library/FileEditView'
import { LibraryPanel } from '../components/library/LibraryPanel'
import { ScannerView } from '../components/ScannerView'
import { SafetyPhraseView } from '../components/SafetyPhraseView'
import { SenderSessionView } from '../components/session/SenderSessionView'
import { ReceiverSessionView } from '../components/session/ReceiverSessionView'
import { SessionEndedView } from '../components/session/SessionEndedView'
import { isSenderRole } from '../components/session/SessionBoard'
import {
  clearLibrarySends,
  isValidSessionCode,
  queueLibrarySends,
  useSession,
} from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'
import type { FileBlock, LibraryFile, LibraryItem } from '../lib/library'
import { describeSendFailure, fileBlocksToLibraryItems } from '../lib/dossier'

/**
 * The blocks a brand-new dossier starts with, so the first thing a user sees in the
 * editor is a shape rather than a blank page. Ids are per-mint: `saveFile` keys blocks by
 * id within a file, and two files made in the same millisecond must not share one.
 */
function newDossierBlocks(): FileBlock[] {
  const stamp = Date.now()
  return [
    { id: `b-${stamp}-1`, type: 'heading', content: 'Section Heading' },
    { id: `b-${stamp}-2`, type: 'shortText', label: 'Key', value: 'Value' },
    {
      id: `b-${stamp}-3`,
      type: 'richText',
      content: 'Add your structured notes, credentials, and attachments here.',
    },
  ]
}

/**
 * Home screen (PLAN.md §7, §16 Phase 5/6, ORCHESTRATION.md D13, D16 and D17).
 *
 * Home is the host: it connects to the signaling server for its minted code on mount, so
 * the QR is visible and joinable the moment the app opens, with no tap in between. The
 * shell it renders is the two-panel desktop surface (D16) — `LibraryPanel` on the left,
 * the QR panel on the right — and below the desktop breakpoint the library leaves the flow
 * entirely and opens from the header, so the QR is the only thing on a phone's screen
 * (D17). Which of those two the viewport gets is `HomeView`'s decision, not this page's:
 * Home hands the panel in as one node and the shell places it.
 *
 * This page owns the surfaces the store cannot: which dossier is open in the editor,
 * whether the camera is up, and which session view replaces the shell once a peer
 * arrives. Library CRUD belongs to the panel and goes straight to the store; the one
 * thing Home still does for the library is create a dossier, because a new dossier is
 * also a decision to open the editor — and it creates into the folder the user was
 * looking at, which the panel hands over (`ROOT_FOLDER_ID` when they were looking at
 * Root). There is no default folder and no fallback id: a dossier goes where the click
 * happened.
 *
 * When a session ends on Home with nothing received and no error, Home restarts it so the
 * next peer gets a joinable QR rather than a burned one (D10).
 */
export function Home() {
  const navigate = useNavigate()

  const folders = useLibraryStore((state) => state.folders)
  const refresh = useLibraryStore((state) => state.refresh)
  const createFile = useLibraryStore((state) => state.createFile)
  const saveFile = useLibraryStore((state) => state.saveFile)
  const updateFile = useLibraryStore((state) => state.updateFile)

  /** True while the camera surface replaces the shell. */
  const [scanning, setScanning] = useState(false)
  /** The dossier currently open in the editor; `null` means the shell is on screen. */
  const [editingFile, setEditingFile] = useState<LibraryFile | null>(null)
  /** Password for the currently open locked dossier, if unlocked. */
  const [editingPassword, setEditingPassword] = useState<string | undefined>(undefined)
  /** The dossier handed to a session by the editor's Send. */
  const [selectedFileForTransfer, setSelectedFileForTransfer] = useState<LibraryFile | null>(null)
  /**
   * Why the last Send put nothing on the channel, in words. Home owns it because Home owns the
   * conversion that refused, and a rejection with no catcher is an unhandled rejection — a page
   * that dies quietly instead of telling the user their dossier did not go out.
   */
  const [sendFailure, setSendFailure] = useState<string | null>(null)

  // Home mounts the host session directly so the QR is visible and joinable immediately.
  const session = useSession({ code: null })

  // The library lives in IndexedDB, so the first render has no data to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (
      session.phase === 'ended' &&
      session.receivedItems.length === 0 &&
      session.errorMessage === null
    ) {
      session.restart()
    }
  }, [session.phase, session.receivedItems.length, session.errorMessage, session.restart])

  /**
   * Creates a dossier in `folderId` and opens it.
   *
   * The folder is a required argument, and it comes from the panel row the user pressed:
   * there is no default folder and no fallback id, so a dossier always goes where the
   * click happened. `Root` is an explicit answer — the library layer's root sentinel is a
   * real target for a file — which is what lets a dossier exist before any folder does.
   */
  const handleCreateNewFile = (folderId: string): void => {
    const opened = (file: LibraryFile): void => {
      setEditingFile(file)
    }
    createFile('New Dossier', folderId, newDossierBlocks()).then(
      opened,
      // The panel renders the store's `error`, so a rejection is already on screen.
      () => undefined,
    )
  }

  const handleSaveFile = (file: LibraryFile): void => {
    setEditingFile(file)
    updateFile(file.id, file).catch(() => undefined)
  }

  /**
   * Converts a dossier and puts it on the channel, reporting every refusal here.
   *
   * Returns whether anything was queued. `lib/dossier.ts` refuses a block it cannot send — an
   * attachment with no file behind it, a locked block that was never encrypted — and the refusal
   * used to be rethrown at the editor, which caught it only because its own wiring happens to
   * await this call. A page-level `await` with no `catch` is an unhandled rejection, and
   * "unreachable by construction" is not a guarantee: this is the call that converts user data
   * into wire frames, so it handles its own failure and names it on screen.
   */
  const handleSendFileDirectly = async (file: LibraryFile): Promise<boolean> => {
    setSelectedFileForTransfer(file)

    let convertedItems: LibraryItem[]
    try {
      convertedItems = await fileBlocksToLibraryItems(file)
    } catch (cause: unknown) {
      setSendFailure(describeSendFailure(cause))
      return false
    }

    setSendFailure(null)
    if (session.phase === 'active') {
      for (const item of convertedItems) {
        session.sendLibraryItem(item)
      }
    } else {
      queueLibrarySends(convertedItems)
    }
    return true
  }

  /**
   * The scan's landing point (PLAN.md §7 flow A).
   */
  const handleScan = (code: string): void => {
    setScanning(false)
    if (!isValidSessionCode(code)) {
      clearLibrarySends()
      return
    }

    clearLibrarySends()
    navigate(`/session?code=${encodeURIComponent(code)}`)
  }

  // 1. SCANNER VIEW
  if (scanning) {
    return (
      <ScannerView
        selectedFile={selectedFileForTransfer}
        onScan={handleScan}
        onCancel={() => {
          clearLibrarySends()
          setScanning(false)
        }}
      />
    )
  }


  // 3. SAFETY PHRASE GATE
  if (session.phase === 'pairing' && session.safetyPhrase) {
    return (
      <SafetyPhraseView
        phrase={session.safetyPhrase}
        confirmed={session.phraseConfirmed}
        peerConfirmed={session.peerConfirmed}
        onConfirm={session.confirmPhrase}
        onAbort={session.abort}
        role={session.role}
      />
    )
  }

  // 4. ACTIVE LIVE SESSION
  if (session.phase === 'active') {
    if (isSenderRole(session.role)) {
      return (
        <SenderSessionView
          session={session}
          sessionFile={selectedFileForTransfer}
          onEndSession={() => session.abort()}
        />
      )
    }
    return (
      <ReceiverSessionView
        session={session}
        folders={folders}
        onSaveToLibrary={(file) => {
          saveFile(file).catch(() => undefined)
        }}
        onEndSession={() => session.abort()}
      />
    )
  }

  // 5. SESSION ENDED SUMMARY
  if (session.phase === 'ended' && session.receivedItems.length > 0) {
    return (
      <SessionEndedView
        session={session}
        folders={folders}
        onSaveFileToLibrary={(file) => {
          saveFile(file).catch(() => undefined)
        }}
        onStartNewSession={() => session.restart()}
        onGoToLibrary={() => session.restart()}
      />
    )
  }

  // 6. DEFAULT HOME VIEW — the shell: library left (or in the drawer), QR or Editor right
  return (
    <HomeView
      pairingCode={session.sessionCode}
      onRegeneratePairing={() => session.restart()}
      onOpenScanner={() => setScanning(true)}
      onJoinCode={(code) => handleScan(code)}
      roleLabel={session.roleLabel}
      errorMessage={session.errorMessage}
      editor={
        editingFile ? (
          <>
            {sendFailure !== null ? (
              <p
                className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700"
                role="alert"
                data-send-failure="true"
              >
                {sendFailure}
              </p>
            ) : null}
            <FileEditView
              file={editingFile}
              initialPassword={editingPassword}
              onBack={() => {
                setEditingFile(null)
                setEditingPassword(undefined)
              }}
              onSaveFile={handleSaveFile}
              onSendFile={async (fileToSend) => {
                // Only open the scanner once the dossier is actually on its way: a refused Send must
                // not walk the user away from the editor that just told them what to fix.
                if (await handleSendFileDirectly(fileToSend)) setScanning(true)
              }}
              folders={folders}
            />
          </>
        ) : undefined
      }
      library={
        <LibraryPanel
          activeFileId={editingFile?.id}
          onSelectFile={(file, password) => {
            setEditingFile(file)
            setEditingPassword(password)
          }}
          onCreateFile={(folderId) => {
            setEditingPassword(undefined)
            handleCreateNewFile(folderId)
          }}
        />
      }
    />
  )
}
