export function MediaPreview({ url, kind }: { url: string; kind: 'video' | 'audio' }) {
  if (kind === 'audio') {
    return (
      <div className="flex items-center justify-center py-10">
        <audio controls src={url} className="w-full max-w-md" />
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center">
      <video controls src={url} className="max-h-[70vh] w-full rounded-md bg-black" />
    </div>
  )
}
