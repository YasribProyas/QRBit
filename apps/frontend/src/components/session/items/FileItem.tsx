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
import { ProgressRing } from '../../ProgressRing'
import type { FileItem as FileItemModel } from '../../../store/sessionStore'

export interface FileItemViewProps {
  /** The store's copy of this item. */
  item: FileItemModel
}

export function FileItem({ item }: FileItemViewProps) {
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

  return (
    <div className="file-item" data-status={item.status}>
      <div className="file-item__row">
        <span className="file-item__name">{item.fileName}</span>
        {transferring ? (
          <ProgressRing progress={item.progress} label={`${item.fileName} transfer progress`} />
        ) : null}
        {transferring ? (
          <span className="file-item__percent muted">{Math.round(item.progress)}%</span>
        ) : null}
      </div>

      {downloadUrl !== null && item.status === 'complete' ? (
        <a className="file-item__download" href={downloadUrl} download={item.fileName}>
          Download
        </a>
      ) : null}

      {item.status === 'error' ? (
        <p className="item-error" role="alert">
          The file transfer failed.
        </p>
      ) : null}
    </div>
  )
}
