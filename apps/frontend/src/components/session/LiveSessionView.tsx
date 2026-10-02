import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  Progress,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconDownload,
  IconEye,
  IconFile,
  IconFileText,
  IconFiles,
  IconFolder,
  IconFolderDown,
  IconFolderPlus,
  IconLock,
  IconLockOpen,
  IconPaperclip,
  IconPencil,
  IconPhoto,
  IconPower,
  IconSend,
  IconShieldCheck,
  IconTrash,
  IconX,
} from '@tabler/icons-react'

import { WithMantine } from '../common/WithMantine'
import { DossierPickerModal } from './DossierPickerModal'
import { LockedItemComposeModal, type LockedItemInput } from './LockedItemComposeModal'
import { FolderPickerModal, type FolderPickerChoice } from '../library/FolderPickerModal'
import { formatByteSize } from '../../lib/byteSize'
import { fileBlocksToLibraryItems, sessionItemsToLibraryFile } from '../../lib/dossier'
import { ROOT_FOLDER_ID, type LibraryFile, type LibraryFolder } from '../../lib/library'
import type { UseSessionResult } from '../../hooks/useSession'
import { useSessionStore } from '../../store/sessionStore'
import type { FileItem, ImageItem, LockedItem, SessionItem, TextItem } from '../../store/sessionStore'

export interface LiveSessionViewProps {
  session: UseSessionResult
  folders: LibraryFolder[]
  onSaveToLibrary: (file: LibraryFile) => void
  onEndSession: () => void
  onOpenDossier?: (file: LibraryFile) => void
}

/** Formats a timestamp into a clean compact time string (e.g. 10:45 AM). */
function formatTimestamp(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: 'numeric',
    }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

/** Triggers download of a Blob file. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function LiveSessionView(props: LiveSessionViewProps) {
  return (
    <WithMantine>
      <LiveSessionViewInner {...props} />
    </WithMantine>
  )
}

function LiveSessionViewInner({
  session,
  folders,
  onSaveToLibrary,
  onEndSession,
  onOpenDossier,
}: LiveSessionViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Modals state
  const [isDossierPickerOpen, setIsDossierPickerOpen] = useState(false)
  const [isNoteComposerOpen, setIsNoteComposerOpen] = useState(false)
  const [noteContent, setNoteContent] = useState('')
  const [isSecretComposerOpen, setIsSecretComposerOpen] = useState(false)
  const [zoomImage, setZoomImage] = useState<{ url: string; name: string } | null>(null)

  // Folder save picker state
  const [isBulkSaveOpen, setIsBulkSaveOpen] = useState(false)
  const [savingSingleItem, setSavingSingleItem] = useState<SessionItem | null>(null)

  // Unlock modal state for locked items
  const [unlockTarget, setUnlockTarget] = useState<LockedItem | null>(null)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [isUnlocking, setIsUnlocking] = useState(false)

  // Feedback notifications
  const [copyFeedbackId, setCopyFeedbackId] = useState<string | null>(null)
  const [saveBannerMessage, setSaveBannerMessage] = useState<string | null>(null)
  const [sendErrorMessage, setSendErrorMessage] = useState<string | null>(null)

  const receivedItems = session?.receivedItems ?? []
  const allItems = useSessionStore((state) => state.items)

  // Blob URLs map for image items to avoid memory leaks
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    const newUrls: Record<string, string> = {}
    for (const item of allItems) {
      if (item.type === 'image' && item.blob && !imageUrls[item.id]) {
        newUrls[item.id] = URL.createObjectURL(item.blob)
      }
    }
    if (Object.keys(newUrls).length > 0) {
      setImageUrls((prev) => ({ ...prev, ...newUrls }))
    }
  }, [allItems])

  useEffect(() => {
    return () => {
      // Clean up object URLs on unmount
      Object.values(imageUrls).forEach((url) => URL.revokeObjectURL(url))
    }
  }, [imageUrls])

  // Clear copy feedback after timeout
  useEffect(() => {
    if (!copyFeedbackId) return
    const timer = setTimeout(() => setCopyFeedbackId(null), 1800)
    return () => clearTimeout(timer)
  }, [copyFeedbackId])

  // Clear save banner after timeout
  useEffect(() => {
    if (!saveBannerMessage) return
    const timer = setTimeout(() => setSaveBannerMessage(null), 3000)
    return () => clearTimeout(timer)
  }, [saveBannerMessage])

  // Tell peer when tab unloads
  const notifyUnload = session.notifyUnload
  const phase = session.phase

  useEffect(() => {
    if (phase !== 'active' && phase !== 'pairing') return

    const handleBeforeUnload = (): void => {
      notifyUnload?.()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [phase, notifyUnload])

  const handleCopyText = (id: string, text: string): void => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopyFeedbackId(id)
      }).catch(() => undefined)
    }
  }

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files
    if (!files || files.length === 0) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file) {
        session.addFileItem(file)
      }
    }
    event.target.value = ''
  }

  const handleSendNote = (): void => {
    const trimmed = noteContent.trim()
    if (!trimmed) return
    session.addTextItem(trimmed)
    setNoteContent('')
    setIsNoteComposerOpen(false)
  }

  const handleSendDossier = async (file: LibraryFile): Promise<void> => {
    try {
      setSendErrorMessage(null)
      const items = await fileBlocksToLibraryItems(file)
      for (const item of items) {
        session.sendLibraryItem(item)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not send dossier'
      setSendErrorMessage(msg)
    }
  }

  const handleUnlockSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!unlockTarget) return

    setIsUnlocking(true)
    setUnlockError(null)

    try {
      const success = await session.unlockItem(unlockTarget.id, unlockPassword)
      if (success) {
        setUnlockTarget(null)
        setUnlockPassword('')
      } else {
        setUnlockError('Incorrect password. Please try again.')
      }
    } catch (err: unknown) {
      setUnlockError(err instanceof Error ? err.message : 'Decryption failed')
    } finally {
      setIsUnlocking(false)
    }
  }

  const handleConfirmBulkSave = (choice: FolderPickerChoice): void => {
    if (receivedItems.length === 0) return

    const targetFolderId = choice.folderId || ROOT_FOLDER_ID
    const now = new Date()
    const title = `Received Dossier (${now.toLocaleDateString()})`

    const newFile = sessionItemsToLibraryFile(title, targetFolderId, receivedItems)
    onSaveToLibrary(newFile)
    setIsBulkSaveOpen(false)
    setSaveBannerMessage(`Saved ${receivedItems.length} items to library as “${title}”`)
  }

  const handleConfirmSingleSave = (choice: FolderPickerChoice): void => {
    if (!savingSingleItem) return

    const targetFolderId = choice.folderId || ROOT_FOLDER_ID
    const item = savingSingleItem
    const title =
      item.type === 'file' || item.type === 'image'
        ? item.fileName
        : item.type === 'locked'
        ? item.label || 'Locked Secret'
        : 'Saved Note'

    const newFile = sessionItemsToLibraryFile(title, targetFolderId, [item])
    onSaveToLibrary(newFile)
    setSavingSingleItem(null)
    setSaveBannerMessage(`Saved item to library as “${title}”`)
  }

  return (
    <div className="session-board flex min-h-0 flex-1 flex-col overflow-y-auto w-full">
      {/* 1. Header Bar */}
      <header
        className="flex items-center justify-between gap-3 px-4 py-3 border-b shrink-0"
        style={{
          borderColor: 'var(--qrbit-border)',
          backgroundColor: 'var(--qrbit-raised)',
        }}
      >
        <Group gap="sm" wrap="nowrap" align="center">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
            <Text className="qrbit-text-headline" c="var(--qrbit-ink)">
              Connected Peer
            </Text>
          </div>

          {session.safetyPhrase ? (
            <Tooltip label="E2E encrypted verification phrase" position="bottom" withArrow>
              <div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-[var(--qrbit-border)] bg-[var(--qrbit-sunken)]">
                <IconShieldCheck size={13} stroke={1.6} className="text-emerald-600 dark:text-emerald-400" />
                <span className="font-mono text-xs font-medium tracking-wider text-[var(--qrbit-ink-secondary)]">
                  {session.safetyPhrase.join(' • ')}
                </span>
              </div>
            </Tooltip>
          ) : null}
        </Group>

        <Group gap="xs" wrap="nowrap" align="center">
          {receivedItems.length > 0 ? (
            <Button
              variant="default"
              size="xs"
              leftSection={<IconFolderDown size={14} stroke={1.5} />}
              onClick={() => setIsBulkSaveOpen(true)}
            >
              Save all to library
            </Button>
          ) : null}

          <Button
            variant="subtle"
            color="danger"
            size="xs"
            leftSection={<IconPower size={14} stroke={1.6} />}
            onClick={onEndSession}
            className="hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            End session
          </Button>
        </Group>
      </header>

      {/* 2. Main Sheet Surface */}
      <main className="flex-1 px-4 py-5 max-w-2xl lg:max-w-3xl xl:max-w-4xl mx-auto w-full space-y-4">
        {saveBannerMessage ? (
          <div
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300 transition-all"
            role="status"
          >
            <IconCheck size={15} stroke={2} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{saveBannerMessage}</span>
          </div>
        ) : null}

        {sendErrorMessage ? (
          <div
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 text-xs text-red-800 dark:text-red-300"
            role="alert"
          >
            <IconAlertCircle size={15} stroke={2} className="text-red-600 dark:text-red-400 shrink-0" />
            <span>{sendErrorMessage}</span>
          </div>
        ) : null}

        {/* Action / Send Bar */}
        <div
          className="add-item-bar flex items-center justify-between gap-2 p-2 rounded-lg border border-[var(--qrbit-border)]"
          style={{ backgroundColor: 'var(--qrbit-raised)' }}
        >
          <Group gap="xs" wrap="wrap">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconFiles size={14} stroke={1.5} />}
              onClick={() => setIsDossierPickerOpen(true)}
            >
              Send dossier
            </Button>

            <Button
              variant="default"
              size="xs"
              leftSection={<IconPaperclip size={14} stroke={1.5} />}
              onClick={() => fileInputRef.current?.click()}
            >
              Send file / image
            </Button>

            <Button
              variant="default"
              size="xs"
              leftSection={<IconPencil size={14} stroke={1.5} />}
              onClick={() => setIsNoteComposerOpen(true)}
            >
              Send note
            </Button>

            <Button
              variant="default"
              size="xs"
              leftSection={<IconLock size={14} stroke={1.5} />}
              onClick={() => setIsSecretComposerOpen(true)}
            >
              Send secret
            </Button>
          </Group>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            multiple
            className="hidden"
            aria-hidden="true"
          />

          <span className="font-mono text-[11px] text-[var(--qrbit-ink-muted)] px-2 hidden sm:inline">
            {allItems.length} {allItems.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        {/* Live Items Feed */}
        <div
          className="divide-y divide-[var(--qrbit-border)] rounded-lg border border-[var(--qrbit-border)] overflow-hidden"
          style={{ backgroundColor: 'var(--qrbit-raised)' }}
        >
          {allItems.length === 0 ? (
            <div className="py-16 px-6 text-center space-y-3">
              <div className="w-10 h-10 mx-auto rounded-full bg-[var(--qrbit-sunken)] flex items-center justify-center text-[var(--qrbit-ink-muted)]">
                <IconSend size={20} stroke={1.5} />
              </div>
              <div className="space-y-1">
                <Text className="qrbit-text-headline" c="var(--qrbit-ink)">
                  Live P2P Connection Ready
                </Text>
                <Text className="qrbit-text-body-secondary max-w-sm mx-auto" c="dimmed">
                  Both devices are connected and encrypted end-to-end. Send a dossier, file, image, or note to begin.
                </Text>
              </div>
              <Group justify="center" gap="xs" pt="xs">
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconFiles size={13} stroke={1.5} />}
                  onClick={() => setIsDossierPickerOpen(true)}
                >
                  Send dossier
                </Button>
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconPaperclip size={13} stroke={1.5} />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Send file
                </Button>
              </Group>
            </div>
          ) : (
            allItems.map((item) => {
              const isReceived = receivedItems.some((r) => r.id === item.id)
              const isSent = !isReceived

              return (
                <div
                  key={item.id}
                  className="group px-4 py-3 hover:bg-[var(--qrbit-selected)] transition-colors space-y-2.5"
                >
                  {/* Item Meta Row */}
                  <div className="flex items-center justify-between gap-2">
                    <Group gap="xs" wrap="nowrap" align="center">
                      {isSent ? (
                        <Badge
                          variant="subtle"
                          color="gray"
                          size="xs"
                          style={{ fontFamily: 'var(--qrbit-font-mono)' }}
                        >
                          You sent
                        </Badge>
                      ) : (
                        <Badge
                          variant="light"
                          color="blue"
                          size="xs"
                          style={{ fontFamily: 'var(--qrbit-font-mono)' }}
                        >
                          Received
                        </Badge>
                      )}

                      <span className="font-mono text-[11px] text-[var(--qrbit-ink-muted)]">
                        {formatTimestamp(item.createdAt)}
                      </span>

                      {item.status === 'transferring' ? (
                        <Badge variant="light" color="yellow" size="xs">
                          {('progress' in item ? item.progress : 0)}%
                        </Badge>
                      ) : item.status === 'error' ? (
                        <Badge variant="light" color="red" size="xs">
                          Failed
                        </Badge>
                      ) : null}
                    </Group>

                    {/* Actions row: quiet by default, darker on hover */}
                    <Group gap="xs" wrap="nowrap" align="center">
                      {isReceived ? (
                        <Tooltip label="Save item to library" withArrow position="left">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            onClick={() => setSavingSingleItem(item)}
                            className="text-[var(--qrbit-ink-muted)] hover:text-[var(--qrbit-ink)]"
                            aria-label="Save item to library"
                          >
                            <IconFolderPlus size={15} stroke={1.5} />
                          </ActionIcon>
                        </Tooltip>
                      ) : (
                        <Tooltip label="Delete item" withArrow position="left">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            onClick={() => session.deleteItem(item.id)}
                            className="text-[var(--qrbit-ink-muted)] hover:text-red-600"
                            aria-label="Delete item"
                          >
                            <IconTrash size={15} stroke={1.5} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Group>
                  </div>

                  {/* Item Content Renderers */}
                  <div className="pt-0.5">
                    {/* TYPE: TEXT */}
                    {item.type === 'text' ? (
                      <div className="space-y-1.5">
                        <div className="qrbit-text-body text-[var(--qrbit-ink)] whitespace-pre-wrap select-text break-words">
                          {item.content}
                        </div>
                        <div className="flex justify-end">
                          <Button
                            variant="subtle"
                            size="compact-xs"
                            color="gray"
                            leftSection={
                              copyFeedbackId === item.id ? (
                                <IconCheck size={12} stroke={2} className="text-emerald-600" />
                              ) : (
                                <IconCopy size={12} stroke={1.5} />
                              )
                            }
                            onClick={() => handleCopyText(item.id, item.content)}
                            className="text-[var(--qrbit-ink-muted)] hover:text-[var(--qrbit-ink)]"
                          >
                            {copyFeedbackId === item.id ? 'Copied' : 'Copy'}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {/* TYPE: FILE */}
                    {item.type === 'file' ? (
                      <div className="space-y-2">
                        {/* 1/3 width compact file box per user feedback */}
                        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-[var(--qrbit-border)] bg-[var(--qrbit-sunken)] max-w-xs">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <IconFile size={18} stroke={1.6} className="text-[var(--qrbit-ink-muted)] shrink-0" />
                            <div className="min-w-0">
                              <p className="qrbit-text-title truncate text-[13px] leading-tight" title={item.fileName}>
                                {item.fileName}
                              </p>
                              <p className="font-mono text-[11px] text-[var(--qrbit-ink-muted)] leading-tight mt-0.5">
                                {formatByteSize(item.totalSize)}
                              </p>
                            </div>
                          </div>

                          {item.blob ? (
                            <Tooltip label="Download file" withArrow>
                              <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="sm"
                                onClick={() => downloadBlob(item.blob!, item.fileName)}
                                className="text-[var(--qrbit-ink-muted)] hover:text-[var(--qrbit-signal)] shrink-0"
                                aria-label="Download file"
                              >
                                <IconDownload size={15} stroke={1.5} />
                              </ActionIcon>
                            </Tooltip>
                          ) : null}
                        </div>

                        {item.status === 'transferring' ? (
                          <Progress value={item.progress} size="xs" color="signal" className="max-w-xs" />
                        ) : null}
                      </div>
                    ) : null}

                    {/* TYPE: IMAGE */}
                    {item.type === 'image' ? (
                      <div className="space-y-2">
                        {imageUrls[item.id] ? (
                          <div className="inline-block">
                            <div
                              onClick={() => setZoomImage({ url: imageUrls[item.id]!, name: item.fileName })}
                              className="relative cursor-pointer group/img overflow-hidden rounded-md border border-[var(--qrbit-border)] max-w-sm bg-[var(--qrbit-sunken)]"
                            >
                              <img
                                src={imageUrls[item.id]}
                                alt={item.fileName}
                                className="object-contain max-h-56 w-auto rounded-md"
                              />
                              <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center text-white">
                                <span className="flex items-center gap-1 text-xs font-medium bg-black/60 px-2 py-1 rounded">
                                  <IconEye size={14} /> View full size
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-2 mt-1 max-w-sm px-1">
                              <span className="font-mono text-[11px] text-[var(--qrbit-ink-muted)] truncate">
                                {item.fileName} ({formatByteSize(item.totalSize)})
                              </span>
                              {item.blob ? (
                                <ActionIcon
                                  variant="subtle"
                                  color="gray"
                                  size="xs"
                                  onClick={() => downloadBlob(item.blob!, item.fileName)}
                                  className="text-[var(--qrbit-ink-muted)] hover:text-[var(--qrbit-signal)]"
                                  aria-label="Download image"
                                >
                                  <IconDownload size={13} stroke={1.5} />
                                </ActionIcon>
                              ) : null}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 p-3 rounded-md bg-[var(--qrbit-sunken)] border border-[var(--qrbit-border)] max-w-xs">
                            <IconPhoto size={18} className="text-[var(--qrbit-ink-muted)]" />
                            <span className="text-xs text-[var(--qrbit-ink-muted)]">
                              Receiving {item.fileName} ({item.progress}%)
                            </span>
                          </div>
                        )}

                        {item.status === 'transferring' ? (
                          <Progress value={item.progress} size="xs" color="signal" className="max-w-xs" />
                        ) : null}
                      </div>
                    ) : null}

                    {/* TYPE: LOCKED SECRET */}
                    {item.type === 'locked' ? (
                      <div className="p-3 rounded-md border border-[var(--qrbit-border)] bg-[var(--qrbit-sunken)] space-y-2 max-w-md">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <IconLock size={16} stroke={1.8} className="text-[var(--qrbit-locked)]" />
                            <Text className="qrbit-text-title text-[13px]" c="var(--qrbit-ink)">
                              {item.label || 'Encrypted Secret'}
                            </Text>
                          </div>

                          {item.unlocked ? (
                            <Badge variant="light" color="green" size="xs">
                              Unlocked (in RAM)
                            </Badge>
                          ) : (
                            <Badge variant="outline" color="orange" size="xs">
                              Encrypted
                            </Badge>
                          )}
                        </div>

                        {item.unlocked && item.plaintextContent !== undefined ? (
                          <div className="space-y-2 pt-1">
                            <div className="p-2 rounded border border-[var(--qrbit-border)] bg-[var(--qrbit-raised)] font-mono text-xs select-text break-all">
                              {typeof item.plaintextContent === 'string'
                                ? item.plaintextContent
                                : '[File attachment unlocked]'}
                            </div>

                            <Group justify="flex-end" gap="xs">
                              {typeof item.plaintextContent === 'string' ? (
                                <Button
                                  variant="subtle"
                                  size="compact-xs"
                                  color="gray"
                                  leftSection={
                                    copyFeedbackId === item.id ? (
                                      <IconCheck size={12} stroke={2} className="text-emerald-600" />
                                    ) : (
                                      <IconCopy size={12} stroke={1.5} />
                                    )
                                  }
                                  onClick={() => handleCopyText(item.id, String(item.plaintextContent))}
                                >
                                  {copyFeedbackId === item.id ? 'Copied' : 'Copy secret'}
                                </Button>
                              ) : null}

                              <Button
                                variant="subtle"
                                size="compact-xs"
                                color="gray"
                                leftSection={<IconLock size={12} stroke={1.5} />}
                                onClick={() => session.lockItemAgain(item.id)}
                              >
                                Lock again
                              </Button>
                            </Group>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <Text className="text-xs text-[var(--qrbit-ink-muted)]">
                              Protected with AES-256-GCM.
                            </Text>
                            <Button
                              variant="default"
                              size="xs"
                              leftSection={<IconLockOpen size={13} stroke={1.6} />}
                              onClick={() => {
                                setUnlockTarget(item)
                                setUnlockPassword('')
                                setUnlockError(null)
                              }}
                            >
                              Unlock
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Bottom summary bar if items were received */}
        {receivedItems.length > 0 ? (
          <div
            className="flex items-center justify-between gap-3 p-3 rounded-lg border border-[var(--qrbit-border)]"
            style={{ backgroundColor: 'var(--qrbit-raised)' }}
          >
            <div className="flex items-center gap-2">
              <IconFolderDown size={16} stroke={1.6} className="text-[var(--qrbit-signal)]" />
              <Text className="qrbit-text-body-secondary" c="var(--qrbit-ink)">
                Received {receivedItems.length} {receivedItems.length === 1 ? 'item' : 'items'} from peer
              </Text>
            </div>
            <Button
              variant="filled"
              color="signal"
              size="xs"
              leftSection={<IconFolderDown size={14} stroke={1.6} />}
              onClick={() => setIsBulkSaveOpen(true)}
            >
              Save all as dossier
            </Button>
          </div>
        ) : null}
      </main>

      {/* MODAL 1: Dossier Picker */}
      <DossierPickerModal
        isOpen={isDossierPickerOpen}
        onClose={() => setIsDossierPickerOpen(false)}
        onSelectDossier={handleSendDossier}
      />

      {/* MODAL 2: Note Composer */}
      <Modal
        opened={isNoteComposerOpen}
        onClose={() => setIsNoteComposerOpen(false)}
        title="Send note to peer"
        size="md"
        centered
        padding="lg"
      >
        <Stack gap="md">
          <Textarea
            placeholder="Write a message, note, links, or text to send…"
            value={noteContent}
            onChange={(e) => setNoteContent(e.currentTarget.value)}
            rows={4}
            size="sm"
            autoFocus
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" size="sm" onClick={() => setIsNoteComposerOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="filled"
              color="signal"
              size="sm"
              leftSection={<IconSend size={14} />}
              disabled={!noteContent.trim()}
              onClick={handleSendNote}
            >
              Send note
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* MODAL 3: Locked Secret Composer */}
      {isSecretComposerOpen ? (
        <LockedItemComposeModal
          onAdd={async (input: LockedItemInput) => {
            const id = await session.addLockedItem(input)
            setIsSecretComposerOpen(false)
            return id
          }}
          onClose={() => setIsSecretComposerOpen(false)}
        />
      ) : null}

      {/* MODAL 4: Unlock Secret Password Prompt */}
      <Modal
        opened={unlockTarget !== null}
        onClose={() => setUnlockTarget(null)}
        title="Unlock secret item"
        size="sm"
        centered
        padding="lg"
      >
        <form onSubmit={handleUnlockSubmit}>
          <Stack gap="md">
            <Text className="qrbit-text-body-secondary" c="dimmed">
              Enter the password to decrypt “{unlockTarget?.label || 'this secret'}”. The decrypted value is kept in RAM only and never saved to storage.
            </Text>

            <PasswordInput
              label="Password"
              placeholder="Enter decryption password"
              value={unlockPassword}
              onChange={(e) => {
                setUnlockPassword(e.currentTarget.value)
                setUnlockError(null)
              }}
              error={unlockError}
              autoFocus
              size="sm"
            />

            <Group justify="flex-end" gap="xs" pt="xs">
              <Button variant="default" size="sm" onClick={() => setUnlockTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="filled"
                color="signal"
                size="sm"
                type="submit"
                loading={isUnlocking}
                disabled={!unlockPassword}
              >
                Unlock
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* MODAL 5: Image Fullscreen Lightbox */}
      <Modal
        opened={zoomImage !== null}
        onClose={() => setZoomImage(null)}
        title={zoomImage?.name || 'Image preview'}
        size="xl"
        centered
        padding="md"
      >
        {zoomImage ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center p-2 rounded-lg bg-[var(--qrbit-sunken)] max-h-[75vh] overflow-hidden">
              <img
                src={zoomImage.url}
                alt={zoomImage.name}
                className="max-h-[70vh] max-w-full object-contain rounded"
              />
            </div>
            <Group justify="space-between" align="center">
              <Text className="font-mono text-xs text-[var(--qrbit-ink-muted)] truncate">
                {zoomImage.name}
              </Text>
              <Group gap="xs">
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconDownload size={14} />}
                  onClick={() => {
                    const a = document.createElement('a')
                    a.href = zoomImage.url
                    a.download = zoomImage.name
                    a.click()
                  }}
                >
                  Download
                </Button>
                <Button variant="default" size="xs" onClick={() => setZoomImage(null)}>
                  Close
                </Button>
              </Group>
            </Group>
          </div>
        ) : null}
      </Modal>

      {/* MODAL 6: Bulk Save Folder Picker */}
      <FolderPickerModal
        isOpen={isBulkSaveOpen}
        onClose={() => setIsBulkSaveOpen(false)}
        folders={folders}
        onSelectFolder={handleConfirmBulkSave}
        fileName={`Received Items (${receivedItems.length})`}
        purpose="save"
      />

      {/* MODAL 7: Single Item Save Folder Picker */}
      <FolderPickerModal
        isOpen={savingSingleItem !== null}
        onClose={() => setSavingSingleItem(null)}
        folders={folders}
        onSelectFolder={handleConfirmSingleSave}
        fileName={
          savingSingleItem?.type === 'file' || savingSingleItem?.type === 'image'
            ? savingSingleItem.fileName
            : savingSingleItem?.type === 'locked'
            ? savingSingleItem.label || 'Secret'
            : 'Note'
        }
        purpose="save"
      />
    </div>
  )
}
