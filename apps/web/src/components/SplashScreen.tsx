import { useLayoutEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { BrandMark } from '@/components/BrandMark'

// Shown full-screen for the one moment nothing else has rendered yet — the
// initial auth check before the app knows whether to show the login form or
// the console. First impression, so it gets the brand mark instead of a
// generic spinner.
export function SplashScreen() {
  const iconWrapRef = useRef<HTMLDivElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ repeat: -1, yoyo: true, defaults: { ease: 'sine.inOut', duration: 1.1 } })
      tl.to(iconWrapRef.current, { scale: 1.1, y: -6 }, 0)
      tl.to(glowRef.current, { scale: 1.2, opacity: 0.85 }, 0)
    })
    return () => ctx.revert()
  }, [])

  return (
    <div className="relative flex h-svh items-center justify-center overflow-hidden bg-background">
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute h-72 w-72 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_25%,transparent)_0%,color-mix(in_oklch,var(--chart-2)_14%,transparent)_45%,transparent_72%)] opacity-70 blur-2xl"
      />
      <div ref={iconWrapRef} className="relative">
        <BrandMark className="h-20 w-auto drop-shadow-[0_14px_32px_color-mix(in_oklch,var(--primary)_40%,transparent)]" />
      </div>
    </div>
  )
}
