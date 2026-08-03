export function ImagePreview({ url, name }: { url: string; name: string }) {
  return (
    <div className="flex items-center justify-center">
      <img src={url} alt={name} className="max-h-[70vh] w-auto max-w-full rounded-md object-contain" />
    </div>
  )
}
