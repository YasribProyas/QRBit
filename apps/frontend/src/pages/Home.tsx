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
import type { FileBlock, LibraryFile } from '../lib/library'
import { fileBlocksToLibraryItems } from '../lib/dossier'

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
 * Home screen (PLAN.md §7, §16 Phase 5/6, ORCHESTRATION.md D13 and D16).
 *
 * Home is the host: it connects to the signaling server for its minted code on mount, so
 * the QR is visible and joinable the moment the app opens, with no tap in between. The
 * shell it renders is the two-panel desktop surface (D16) — `LibraryPanel` on the left,
 * the QR panel on the right, one column on a phone.
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
  /** The dossier handed to a session by the editor's Send. */
  const [selectedFileForTransfer, setSelectedFileForTransfer] = useState<LibraryFile | null>(null)

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

  const handleSendFileDirectly = async (file: LibraryFile): Promise<void> => {
    setSelectedFileForTransfer(file)
    const convertedItems = await fileBlocksToLibraryItems(file)
    if (session.phase === 'active') {
      for (const item of convertedItems) {
        session.sendLibraryItem(item)
      }
    } else {
      queueLibrarySends(convertedItems)
    }
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

  // 2. FILE EDIT VIEW (Full Dossier Editor)
  if (editingFile) {
    return (
      <FileEditView
        file={editingFile}
        onBack={() => setEditingFile(null)}
        onSaveFile={handleSaveFile}
        onSendFile={async (fileToSend) => {
          await handleSendFileDirectly(fileToSend)
          setScanning(true)
        }}
        folders={folders}
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

  // 6. DEFAULT HOME VIEW — the two-panel shell: library left, QR right (D16)
  return (
    <HomeView
      pairingCode={session.sessionCode}
      onRegeneratePairing={() => session.restart()}
      onOpenScanner={() => setScanning(true)}
      onJoinCode={(code) => handleScan(code)}
      roleLabel={session.roleLabel}
      errorMessage={session.errorMessage}
      library={
        <LibraryPanel
          onSelectFile={(file) => setEditingFile(file)}
          onCreateFile={(folderId) => handleCreateNewFile(folderId)}
        />
      }
    />
  )
}
