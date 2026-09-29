/**
 * File item (PLAN.md §9).
 *
 * One row, two states: a filename plus a progress ring while the chunks are in
 * flight, and a download link once the assembled Blob is on the item. The sender
 * sees the same row and can also re-download its own file, which is what makes the
 * view symmetric in the sense PLAN.md §1 asks for.
 *
 * The download URL is created here and revoked here — on replacement and on
 * unmount, which is also how an item removal presents itself. A revoked URL is the
 * only resource leak this component could have, and the Blob itself never leaves
 * memory: AGENTS.md forbids writing session data to IndexedDB, the Cache API or
 * localStorage.
 */

import { useEffect, useState } from 'react'
import { Badge, Group, Text } from '@mantine/core'
import { IconCircleCheck, IconFileDownload } from '@tabler/icons-react'
import { ProgressRing } from '../../ProgressRing'
import { WithMantine } from '../../common/WithMantine'
import { formatByteSize } from '../../../lib/byteSize'
import type { FileItem as FileItemModel } from '../../../store/sessionStore'

export interface FileItemViewProps {
  /** The store's copy of this item. */
  item: FileItemModel
}

export function FileItem(props: FileItemViewProps) {
  return (
    <WithMantine>
      <FileItemInner {...props} />
    </WithMantine>
  )
}

function FileItemInner({ item }: FileItemViewProps) {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  /*
   * Keyed on the Blob alone. `status` and `progress` change many times during a
   * transfer and including them would revoke a URL that is still in use and hand
   * back a dead link.
   */
  useEffect(() => {
    const blob = item.blob
    if (blob === undefined) {
      setDownloadUrl(null)
      return
    }

    const created = URL.createObjectURL(blob)
    setDownloadUrl(created)
    return () => {
      URL.revokeObjectURL(created)
    }
  }, [item.blob])

  const transferring = item.status === 'pending' || item.status === 'transferring'
  const size = item.totalSize > 0 ? formatByteSize(item.totalSize) : null

  return (
    <div className="file-item" data-status={item.status}>
      <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
        <Text span className="file-item__name qrbit-text-body" style={{ overflowWrap: 'anywhere' }}>
          {item.fileName}
        </Text>
        {transferring ? (
          <Group gap="xs" wrap="nowrap">
            <ProgressRing progress={item.progress} label={`${item.fileName} transfer progress`} />
            {/* Data role: mono with tabular figures, so the counter cannot reflow the row. */}
            <Text span className="file-item__percent qrbit-text-data" c="warning">
              {Math.round(item.progress)}%
            </Text>
          </Group>
        ) : null}
      </Group>

      {/* Every number here is the store's own: the announce's byte count and chunk count. */}
      {size !== null || item.totalChunks > 0 ? (
        <Group gap="sm" wrap="nowrap">
          {size !== null ? (
            <Text span className="qrbit-text-data" c="dimmed">
              {size}
            </Text>
          ) : null}
          {item.totalChunks > 0 ? (
            <Text span className="qrbit-text-data" c="dimmed">
              {item.totalChunks} chunks
            </Text>
          ) : null}
        </Group>
      ) : null}

      {downloadUrl !== null && item.status === 'complete' ? (
        <Group gap="sm" wrap="nowrap">
          <Badge
            variant="light"
            color="success"
            radius="full"
            ff="sans"
            leftSection={<IconCircleCheck size={13} aria-hidden="true" />}
          >
            Complete
          </Badge>
          <a className="file-item__download" href={downloadUrl} download={item.fileName}>
            <Group gap="xs" wrap="nowrap">
              <IconFileDownload size={16} aria-hidden="true" />
              <span>Download</span>
            </Group>
          </a>
        </Group>
      ) : null}

      {item.status === 'error' ? (
        <Text span className="item-error" c="danger" role="alert">
          The file transfer failed.
        </Text>
      ) : null}
    </div>
  )
}
