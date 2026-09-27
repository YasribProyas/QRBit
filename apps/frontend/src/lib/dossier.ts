import type { FileBlock, LibraryFile, LibraryItem } from './library'
import { encryptItem } from './crypto'
import type { SessionItem } from '../store/sessionStore'

/**
 * Extracts a concise single-line preview from the first block of a file.
 */
export function getFirstBlockPreview(file: LibraryFile): string {
  if (!file.blocks || file.blocks.length === 0) return 'Empty dossier'
  const b = file.blocks[0]
  if (!b) return 'Empty dossier'

  if (b.type === 'heading') return b.content || 'Heading block'
  if (b.type === 'shortText') return `${b.label || 'Field'}: ${b.value || ''}`
  if (b.type === 'richText') {
    return b.content ? b.content.split('\n')[0] || 'Notes' : 'Notes'
  }
  if (b.type === 'image') return `Image: ${b.fileName || 'attachment.png'}`
  if (b.type === 'fileAttachment') {
    return `Attachment: ${b.fileName || 'file.bin'} (${b.fileSize || ''})`
  }
  if (b.type === 'locked' || b.isLocked) return `Encrypted: ${b.label || 'Secret'}`
  return 'Block content preview'
}

/**
 * Returns true if the file contains any password-locked entities.
 */
export function hasLockedBlocks(file: LibraryFile): boolean {
  return file.blocks?.some((b) => b.type === 'locked' || b.isLocked === true) ?? false
}

/**
 * Converts a multi-entity LibraryFile into an array of transportable LibraryItems
 * that can be transmitted over the WebRTC DataChannel via useSession.
 */
export async function fileBlocksToLibraryItems(file: LibraryFile): Promise<LibraryItem[]> {
  const items: LibraryItem[] = []
  const now = Date.now()

  for (const block of file.blocks) {
    if (block.type === 'divider') continue

    if (block.type === 'heading') {
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.content || 'Heading',
        type: 'text',
        content: `# ${block.content || ''}`,
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'shortText') {
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.label || 'Short Text',
        type: 'text',
        content: `${block.label ? block.label + ': ' : ''}${block.value || ''}`,
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'richText') {
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.label || 'Notes',
        type: 'text',
        content: block.content || '',
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'image') {
      const blob =
        block.blob ||
        new Blob([new Uint8Array(100)], { type: block.mimeType || 'image/png' })
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.fileName || 'Image',
        type: 'image',
        blob,
        mimeType: block.mimeType || 'image/png',
        size: blob.size,
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'fileAttachment') {
      const blob =
        block.blob ||
        new Blob([new Uint8Array(100)], {
          type: block.mimeType || 'application/octet-stream',
        })
      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.fileName || 'Attachment',
        type: 'file',
        blob,
        mimeType: block.mimeType || 'application/octet-stream',
        size: blob.size,
        createdAt: now,
        updatedAt: now,
      })
    } else if (block.type === 'locked' || block.isLocked) {
      let ciphertext: Uint8Array
      let iv: Uint8Array
      let salt: Uint8Array

      if (
        block.lockedData &&
        block.lockedData.ciphertext instanceof Uint8Array &&
        block.lockedData.iv instanceof Uint8Array &&
        block.lockedData.salt instanceof Uint8Array
      ) {
        ciphertext = block.lockedData.ciphertext
        iv = block.lockedData.iv
        salt = block.lockedData.salt
      } else {
        const enc = await encryptItem(
          block.password || 'pass',
          new TextEncoder().encode(block.content || block.value || 'secret'),
        )
        ciphertext = enc.ciphertext
        iv = enc.iv
        salt = enc.salt
      }

      items.push({
        id: block.id,
        folderId: file.folderId,
        name: block.label || 'Locked Payload',
        label: block.label || 'Locked Payload',
        type: 'locked',
        innerType: 'text',
        ciphertext,
        iv,
        salt,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  return items
}

/**
 * Converts incoming SessionItems from a live session back into a structured LibraryFile.
 */
export function sessionItemsToLibraryFile(
  name: string,
  folderId: string,
  sessionItems: SessionItem[],
): LibraryFile {
  const now = Date.now()
  const blocks: FileBlock[] = sessionItems.map((item) => {
    switch (item.type) {
      case 'text': {
        if (item.content.startsWith('# ')) {
          return {
            id: item.id,
            type: 'heading',
            content: item.content.slice(2),
          }
        }
        if (item.content.includes(': ')) {
          const [label, ...rest] = item.content.split(': ')
          return {
            id: item.id,
            type: 'shortText',
            label,
            value: rest.join(': '),
          }
        }
        return {
          id: item.id,
          type: 'richText',
          content: item.content,
        }
      }
      case 'richtext':
        return {
          id: item.id,
          type: 'richText',
          content: item.content,
        }
      case 'image':
        return {
          id: item.id,
          type: 'image',
          fileName: item.fileName,
          fileSize: `${Math.round(item.totalSize / 1024)} KB`,
          blob: item.blob,
          mimeType: item.mimeType,
        }
      case 'file':
        return {
          id: item.id,
          type: 'fileAttachment',
          fileName: item.fileName,
          fileSize: `${Math.round(item.totalSize / 1024)} KB`,
          blob: item.blob,
          mimeType: item.mimeType,
        }
      case 'locked':
        return {
          id: item.id,
          type: 'locked',
          label: item.label,
          content: typeof item.plaintextContent === 'string' ? item.plaintextContent : undefined,
          isLocked: true,
          lockedData: {
            ciphertext: item.ciphertext,
            iv: item.iv,
            salt: item.salt,
            innerType: item.innerType === 'file' ? 'fileAttachment' : 'shortText',
          },
          isUnlocked: item.unlocked ?? false,
        }
    }
  })

  return {
    id: globalThis.crypto.randomUUID(),
    folderId,
    name,
    createdAt: now,
    updatedAt: now,
    blocks,
  }
}
