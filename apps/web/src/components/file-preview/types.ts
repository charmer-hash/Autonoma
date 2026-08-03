// Deferred, not a plain string: resolving the actual URL requires an API
// call (GET /api/artifacts/:id?raw=1 — see lib/artifacts-api.ts), and
// FilePreview shouldn't fire that until it's actually mounted/shown.
export type FilePreviewSource = {
  name: string
  mimeType: string
  resolveUrl: () => Promise<string>
}
