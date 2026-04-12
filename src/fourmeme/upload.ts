/**
 * Four.meme image upload.
 *
 * POST /v1/private/token/upload with multipart form data.
 * Returns the uploaded image URL for use in token creation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../lib/config.js'

export type UploadResult = {
  imageUrl: string
}

/**
 * Upload a token logo image to Four.meme.
 */
export async function uploadTokenImage(
  imagePath: string,
  accessToken: string,
  options: { fetchImpl?: typeof fetch | undefined } = {},
): Promise<UploadResult> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const config = loadConfig()
  const apiBase = config.fourmemeApiUrl

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`)
  }

  const fileBuffer = fs.readFileSync(imagePath)
  const fileName = path.basename(imagePath)

  // Detect MIME type from extension so the server accepts the upload
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }
  const ext = path.extname(imagePath).toLowerCase()
  const mimeType = mimeTypes[ext] ?? 'application/octet-stream'
  const blob = new Blob([fileBuffer], { type: mimeType })

  const formData = new FormData()
  formData.append('file', blob, fileName)

  const res = await fetchFn(`${apiBase}/v1/private/token/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  })

  if (!res.ok) {
    throw new Error(`Four.meme upload failed: HTTP ${res.status}`)
  }

  const json = (await res.json()) as { code: number; data: string }
  if (json.code !== 0 || !json.data) {
    throw new Error(`Four.meme upload error: ${JSON.stringify(json)}`)
  }

  return { imageUrl: json.data }
}
