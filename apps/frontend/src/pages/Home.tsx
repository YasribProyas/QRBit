import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HomeView } from '../components/HomeView'
import { FileEditView } from '../components/library/FileEditView'
import { ScannerView } from '../components/ScannerView'
import { SafetyPhraseView } from '../components/SafetyPhraseView'
import { SenderSessionView } from '../components/session/SenderSessionView'
import { ReceiverSessionView } from '../components/session/ReceiverSessionView'
import { SessionEndedView } from '../components/session/SessionEndedView'
import { LibraryBrowser } from '../components/library/LibraryBrowser'
import { isSenderRole } from '../components/session/SessionBoard'
import {
  clearLibrarySends,
  isValidSessionCode,
  queueLibrarySends,
  useSession,
} from '../hooks/useSession'
import { useLibraryStore } from '../store/libraryStore'
import type { LibraryFile } from '../lib/library'
import { fileBlocksToLibraryItems } from '../lib/dossier'

/**
 * Stops an unhandled rejection from the browser's `void` callbacks.
 */
function reportToStore(operation: Promise<unknown>): void {
  void operation.catch(() => undefined)
}

/**
 * Home screen (PLAN.md §7, §16 Phase 5/6, ORCHESTRATION.md D13).
 *
 * Full Adoption of QRBit / qrd-design System & UX:
 * - Single-column responsive layout (no hidden drawers or split dual-panes)
 * - Section 1: Beacon Ready Tactical QR Code card with reticle, telemetry, and manual fallback
 * - Section 2: Local Library with folders accordion, "+ New File", file cards with preview & encrypted badges
 * - FileEditView: Full multi-entity dossier editor with per-block label and per-block lock
 * - ScannerView: Optical transceiver with laser sweep line and viewfinder
 * - SafetyPhraseView: 3 prominent verification words with confirm match
 * - Active Session: Sender / Receiver views with real-time block streaming
 * - SessionEndedView: Complete summary and Save Whole Dossier to Library
 */
export function Home() {
  const navigate = useNavigate()

  const folders = useLibraryStore((state) => state.folders)
  const items = useLibraryStore((state) => state.items)
  const files = useLibraryStore((state) => state.files)
  const loading = useLibraryStore((state) => state.loading)
  const error = useLibraryStore((state) => state.error)
  const refresh = useLibraryStore((state) => state.refresh)
  const createFolder = useLibraryStore((state) => state.createFolder)
  const renameFolder = useLibraryStore((state) => state.renameFolder)
  const deleteFolder = useLibraryStore((state) => state.deleteFolder)
  const renameItem = useLibraryStore((state) => state.renameItem)
  const deleteItem = useLibraryStore((state) => state.deleteItem)
  const moveItem = useLibraryStore((state) => state.moveItem)
  const createFile = useLibraryStore((state) => state.createFile)
  const saveFile = useLibraryStore((state) => state.saveFile)
  const updateFile = useLibraryStore((state) => state.updateFile)

  /** The folder whose items are listed; `null` is the tree's Root. */
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)

  /** The library browser's current selection (PLAN.md §7 Flow A). */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [scanning, setScanning] = useState(false)

  /** Dossier file currently being authored or edited */
  const [editingFile, setEditingFile] = useState<LibraryFile | null>(null)
  /** Selected file for immediate transfer */
  const [selectedFileForTransfer, setSelectedFileForTransfer] = useState<LibraryFile | null>(null)

  // Home mounts the host session directly so the QR is visible and joinable immediately.
  const session = useSession({ code: null })

  // The library lives in IndexedDB, so the first render has no data to show.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // When a session ends on Home without received items or errors, auto-recover by restarting
  // to mint a fresh code so the next peer gets a joinable QR rather than a burned one.
  useEffect(() => {
    if (
      session.phase === 'ended' &&
      session.receivedItems.length === 0 &&
      session.errorMessage === null
    ) {
      session.restart()
    }
  }, [session.phase, session.receivedItems.length, session.errorMessage, session.restart])

  const handleCreateNewFile = async () => {
    const targetFolder = folders[0]?.id || 'f-1'
    const newFile = await createFile('New Dossier', targetFolder, [
      { id: `b-${Date.now()}-1`, type: 'heading', content: 'Section Heading' },
      { id: `b-${Date.now()}-2`, type: 'shortText', label: 'Key', value: 'Value' },
      {
        id: `b-${Date.now()}-3`,
        type: 'richText',
        content: 'Add your structured notes, credentials, and attachments here.',
      },
    ])
    setEditingFile(newFile)
  }

  const handleSaveFile = (file: LibraryFile) => {
    setEditingFile(file)
    void updateFile(file.id, file)
  }

  const handleSendFileDirectly = async (file: LibraryFile) => {
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
   * PLAN.md §7 flow A / decision D8: hand the selection to the session.
   * Since Home is the host, queued items will send as soon as the session goes active.
   */
  const sendSelected = (ids: string[]): void => {
    const selected = items.filter((item) => ids.includes(item.id))
    if (selected.length === 0) return

    queueLibrarySends(selected)
  }

  const handleSelectionChange = useCallback((ids: readonly string[]): void => {
    setSelectedIds(ids)
  }, [])

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
    if (selectedIds.length > 0) {
      const selected = items.filter((item) => selectedIds.includes(item.id))
      if (selected.length > 0) queueLibrarySends(selected)
    }

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
          void saveFile(file)
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
          void saveFile(file)
        }}
        onStartNewSession={() => session.restart()}
        onGoToLibrary={() => session.restart()}
      />
    )
  }

  // 6. DEFAULT HOME VIEW
  const libraryBrowserNode = (
    <LibraryBrowser
      folders={folders}
      items={items}
      currentFolderId={currentFolderId}
      onSelectFolder={setCurrentFolderId}
      onCreateFolder={async (name, parentId) => {
        await createFolder(name, parentId)
      }}
      onRenameFolder={(id, name) => {
        reportToStore(renameFolder(id, name))
      }}
      onDeleteFolder={(id) => {
        reportToStore(deleteFolder(id))
      }}
      onRenameItem={(id, name) => {
        reportToStore(renameItem(id, name))
      }}
      onMoveItem={(id, targetFolderId) => {
        reportToStore(moveItem(id, targetFolderId))
      }}
      onDeleteItem={(id) => {
        reportToStore(deleteItem(id))
      }}
      onSendItems={sendSelected}
      onSelectionChange={handleSelectionChange}
      loading={loading}
      error={error}
    />
  )

  return (
    <HomeView
      pairingCode={session.sessionCode}
      onRegeneratePairing={() => session.restart()}
      folders={folders}
      files={files}
      libraryContent={libraryBrowserNode}
      onSelectFileToEdit={(file) => setEditingFile(file)}
      onSendFileDirectly={async (file) => {
        await handleSendFileDirectly(file)
        setScanning(true)
      }}
      onOpenScanner={() => setScanning(true)}
      onCreateNewFile={handleCreateNewFile}
      onJoinCode={(code) => handleScan(code)}
      selectedCount={selectedIds.length}
      roleLabel={session.roleLabel}
      errorMessage={session.errorMessage}
    />
  )
}
