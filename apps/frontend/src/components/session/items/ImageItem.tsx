/**
 * Image item (PLAN.md §9).
 *
 * Sender: the local preview is up as soon as the item exists, because the item
 * carries the source file's Blob.
 *
 * Receiver: progressive reveal. The transport writes the partially assembled Blob
 * onto the item as chunks land, and re-creating an object URL and an <img> for
 * every one of those updates would thrash the image decoder on a large photo, so
 * the preview is refreshed at most MAX_PREVIEW_STEPS times per item. The completed
 * blob is always shown, whatever the step count.
 *
 * Object URLs are the only thing about a Blob that needs releasing, and nothing
 * else owns them, so this component revokes every URL it created — on replacement
 * and on unmount (which is also what an item removal looks like, since the row
 * disappears). No session Blob ever reaches IndexedDB, the Cache API or
 * localStorage (AGENTS.md): the store keeps them in memory and the URLs are
 * process-local.
 */

import { useEffect, useRef, useState } from 'react'
import { Badge, Group, Text } from '@mantine/core'
import { IconCircleCheck } from '@tabler/icons-react'
import { ProgressRing } from '../../ProgressRing'
import { WithMantine } from '../../common/WithMantine'
import { formatByteSize } from '../../../lib/byteSize'
import type { ImageItem as ImageItemModel } from '../../../store/sessionStore'

/**
 * Upper bound on how many previews a single image item builds.
 *
 * Eight is comfortably more than the eye needs on a phone-sized thumbnail while
 * keeping decoder work flat: a 1 GiB image is ~65k chunks (PLAN.md §12), so an
 * unbounded implementation would rebuild the preview thousands of times even with
 * the transport's own progress throttling.
 */
export const MAX_PREVIEW_STEPS = 8

export interface ImageItemViewProps {
  /** The store's copy of this item. */
  item: ImageItemModel
}

export function ImageItem(props: ImageItemViewProps) {
  return (
    <WithMantine>
      <ImageItemInner {...props} />
    </WithMantine>
  )
}

function ImageItemInner({ item }: ImageItemViewProps) {
  const [preview, setPreview] = useState<string | null>(null)
  /** The URL this component created and must therefore revoke. */
  const ownedUrl = useRef<string | null>(null)
  /** How many previews this item has built — capped by MAX_PREVIEW_STEPS. */
  const previewSteps = useRef(0)

  const revokeOwned = (): void => {
    if (ownedUrl.current === null) return
    URL.revokeObjectURL(ownedUrl.current)
    ownedUrl.current = null
  }

  useEffect(() => {
    const published = item.objectURL !== undefined && item.objectURL !== '' ? item.objectURL : null
    const blob = item.blob ?? null
    const canRefresh = item.status === 'complete' || previewSteps.current < MAX_PREVIEW_STEPS

    let next: string | null = published
    if (next === null && blob !== null) {
      if (canRefresh) {
        previewSteps.current += 1
        next = URL.createObjectURL(blob)
      } else {
        // At the cap: hold the last preview instead of blanking the frame. The
        // complete blob is never blocked above, so this is a hold, not a stop.
        next = ownedUrl.current
      }
    }

    // Unchanged: keep the live URL rather than revoking and rebuilding it, which
    // would blank the image for a frame.
    if (next === ownedUrl.current) return

    revokeOwned()
    ownedUrl.current = next
    setPreview(next)
  }, [item.objectURL, item.blob, item.status])

  // Unmount is the last moment these URLs are still valid for anybody.
  useEffect(() => revokeOwned, [])

  const transferring = item.status === 'pending' || item.status === 'transferring'
  const size = item.totalSize > 0 ? formatByteSize(item.totalSize) : null

  return (
    <div className="image-item" data-status={item.status}>
      <div className="image-item__frame">
        {preview !== null ? (
          <img className="image-item__preview" src={preview} alt={item.fileName} />
        ) : (
          <p className="image-item__placeholder muted">
            {item.status === 'error' ? 'The image transfer failed.' : 'Waiting for the first bytes…'}
          </p>
        )}
        {transferring ? (
          <span className="image-item__ring">
            <ProgressRing
              progress={item.progress}
              label={`${item.fileName} transfer progress`}
            />
          </span>
        ) : null}
      </div>

      <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
        <Text span className="image-item__name qrbit-text-body" style={{ overflowWrap: 'anywhere' }}>
          {item.fileName}
        </Text>
        {/* Mono + tabular figures: the counter must not reflow the name beside it. */}
        <Group gap="xs" wrap="nowrap">
          {size !== null ? (
            <Text span className="qrbit-text-data" c="dimmed">
              {size}
            </Text>
          ) : null}
          {transferring ? (
            <Text span className="image-item__percent qrbit-text-data" c="warning">
              {Math.round(item.progress)}%
            </Text>
          ) : null}
          {item.status === 'complete' ? (
            <Badge
              variant="light"
              color="success"
              radius="full"
              ff="sans"
              leftSection={<IconCircleCheck size={13} aria-hidden="true" />}
            >
              Complete
            </Badge>
          ) : null}
        </Group>
      </Group>

      {item.status === 'error' ? (
        <Text span role="alert" className="item-error" c="danger">
          The image transfer failed.
        </Text>
      ) : null}
    </div>
  )
}
