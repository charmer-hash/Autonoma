import { useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { Loader2 } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { Input } from '@autonoma/ui/components/input'
import { BrandMark } from '@/components/BrandMark'
import { login } from '@/lib/auth-api'

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLFormElement>(null)
  const shineRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ctx = gsap.context(() => {
      const blobs = gsap.utils.toArray<HTMLElement>('.aurora-blob')

      if (reduceMotion) {
        gsap.set(cardRef.current, { opacity: 1, y: 0, scale: 1 })
        gsap.set('.stagger-item', { opacity: 1, y: 0 })
        return
      }

      // Entrance: card settles in, then its contents stagger up after it.
      gsap
        .timeline()
        .from(cardRef.current, { opacity: 0, y: 28, scale: 0.96, duration: 0.7, ease: 'power3.out' })
        .from(
          '.stagger-item',
          { opacity: 0, y: 10, duration: 0.45, stagger: 0.07, ease: 'power2.out' },
          '-=0.35',
        )

      // Aurora blobs drift slowly and independently — keeps the background alive
      // without drawing attention away from the form.
      blobs.forEach((blob, i) => {
        gsap.to(blob, {
          x: gsap.utils.random(-50, 50),
          y: gsap.utils.random(-40, 40),
          duration: 9 + i * 2.5,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        })
      })

      // A light sweep across the primary button, on a loop with a pause between passes.
      gsap.set(shineRef.current, { xPercent: -150 })
      gsap.to(shineRef.current, {
        xPercent: 250,
        duration: 1.1,
        repeat: -1,
        repeatDelay: 2.6,
        ease: 'power2.inOut',
      })
    }, rootRef)

    return () => ctx.revert()
  }, [])

  function onButtonMouseMove(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = e.clientX - (rect.left + rect.width / 2)
    const relY = e.clientY - (rect.top + rect.height / 2)
    gsap.to(e.currentTarget, { x: relX * 0.12, y: relY * 0.3, duration: 0.4, ease: 'power2.out' })
  }

  function onButtonMouseLeave(e: React.MouseEvent<HTMLButtonElement>) {
    gsap.to(e.currentTarget, { x: 0, y: 0, duration: 0.5, ease: 'elastic.out(1, 0.4)' })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    const result = await login(username, password)
    setSubmitting(false)
    if (result.ok) {
      onSuccess()
    } else {
      setError(result.error ?? '登录失败')
      if (cardRef.current) {
        gsap.fromTo(
          cardRef.current,
          { x: -8 },
          { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.35)' },
        )
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative flex h-svh items-center justify-center overflow-hidden bg-background px-4 text-foreground"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="aurora-blob absolute top-[-12rem] left-1/2 h-[38rem] w-[38rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[110px]" />
        <div className="aurora-blob absolute right-[-12rem] bottom-[-12rem] h-[28rem] w-[28rem] rounded-full bg-chart-2/20 blur-[110px]" />
        <div className="aurora-blob absolute top-1/3 left-[-8rem] h-[22rem] w-[22rem] rounded-full bg-chart-3/15 blur-[100px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_oklch,var(--foreground)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--foreground)_6%,transparent)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_60%_45%_at_50%_0%,black,transparent)]" />
      </div>

      <form
        ref={cardRef}
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm space-y-6 rounded-2xl border border-border bg-card/85 p-8 shadow-[0_24px_70px_-30px_color-mix(in_oklch,var(--primary)_40%,transparent),0_8px_24px_-12px_rgba(0,0,0,0.1)] backdrop-blur-2xl"
      >
        <div className="stagger-item flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-11" />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">登录 Autonoma</h1>
            <p className="text-sm text-muted-foreground">请输入账号密码以继续</p>
          </div>
        </div>

        <div className="space-y-3.5">
          <div className="stagger-item space-y-1.5">
            <label htmlFor="username" className="text-sm font-medium text-foreground/80">
              用户名
            </label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              autoFocus
              className="h-10"
            />
          </div>
          <div className="stagger-item space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium text-foreground/80">
              密码
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="h-10"
            />
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <Button
          ref={buttonRef}
          type="submit"
          onMouseMove={onButtonMouseMove}
          onMouseLeave={onButtonMouseLeave}
          className="stagger-item relative h-10 w-full overflow-hidden bg-gradient-to-r from-primary to-chart-2 text-primary-foreground shadow-[0_10px_30px_-10px_color-mix(in_oklch,var(--primary)_60%,transparent)] transition-shadow hover:shadow-[0_14px_36px_-8px_color-mix(in_oklch,var(--primary)_70%,transparent)]"
          disabled={submitting || !username || !password}
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : '登录'}
          <span
            ref={shineRef}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-1/3 -skew-x-12 bg-white/25"
          />
        </Button>
      </form>
    </div>
  )
}
