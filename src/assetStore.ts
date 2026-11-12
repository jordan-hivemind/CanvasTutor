// Images on canvases are uploaded to the server as files (see server/assets.ts) instead of being
// stored inline in the canvas, which kept big canvases slow to open.
import type { TLAssetStore } from 'tldraw'
import { AuthError } from './api'

export async function uploadImage(blob: Blob): Promise<string> {
  const r = await fetch('/api/assets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob })
  if (r.status === 401) throw new AuthError('Not logged in')
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Upload failed (${r.status})`)
  return ((await r.json()) as { src: string }).src
}

export const assetStore: TLAssetStore = {
  upload: async (_asset, file) => ({ src: await uploadImage(file) }),
  resolve: (asset) => asset.props.src,
}
