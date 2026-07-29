// The Autonoma mascot — same asset as /public/favicon.svg, reused as the
// in-app "agent" glyph everywhere a brand icon is needed.
export function BrandMark({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden className={className} />
}
