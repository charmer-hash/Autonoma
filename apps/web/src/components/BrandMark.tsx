// Autonoma 的吉祥物——与 /public/favicon.svg 是同一份资源，
// 在应用内任何需要品牌图标的地方复用作“agent”标志。
export function BrandMark({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden className={className} />
}
