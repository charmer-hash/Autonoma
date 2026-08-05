import { useLayoutEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { Loader2 } from 'lucide-react'
import { Button } from '@autonoma/ui/components/button'
import { Input } from '@autonoma/ui/components/input'
import { cn } from '@autonoma/ui/lib/utils'
import { BrandMark } from '@/components/BrandMark'
import { login } from '@/lib/auth-api'

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // 只做"是否为空"这一种校验，且只在真正尝试提交时才点亮——不在
  // onChange 时机就报错，那样用户还没打完字就被红框劝退。字段一旦
  // 被改动就立刻清掉对应的错误态，不用等到下次提交才消失。
  const [fieldErrors, setFieldErrors] = useState<{ username?: boolean; password?: boolean }>({})
  const incomplete = !username.trim() || !password

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

      // 入场动画：卡片先落定，然后其内容依次错落浮现。提交按钮故意不参与
      // 这个淡入——实测无论是用 `.stagger-item` 选择器还是显式 buttonRef
      // 去动画它的 opacity，都出现过按钮卡在动画起始帧（opacity:0）、
      // 永远动不到 1、整个按钮"消失"的情况（大概率是 base-ui 的 Button
      // 组件跟 GSAP 对同一个节点的渲染时机有冲突，具体机制没有深挖）。
      // 提交按钮是页面里最不能承受"意外不可见"风险的元素，所以干脆
      // 不对它做入场动画，直接以正常状态渲染，其余三项照常淡入错落。
      gsap
        .timeline()
        .from(cardRef.current, { opacity: 0, y: 28, scale: 0.96, duration: 0.7, ease: 'power3.out' })
        .from(
          '.stagger-item',
          { opacity: 0, y: 10, duration: 0.45, stagger: 0.07, ease: 'power2.out' },
          '-=0.35',
        )

      // 极光光斑各自缓慢漂移——让背景保持生动，同时又不会把注意力
      // 从表单上吸引走。
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

      // 一道光扫过主按钮，循环播放，每次扫过之间有一段停顿。停顿期间光带
      // 必须真正移出按钮范围——光带宽度只有自身的 w-1/3，之前用的
      // xPercent:250（按自身宽度算）只够走到按钮内约 83% 的位置，
      // 停顿时会变成一块卡在按钮中间、不会动的白块。这里把终点推到
      // 400%，确保停顿时光带完全在 overflow-hidden 裁剪范围之外。
      gsap.set(shineRef.current, { xPercent: -150 })
      gsap.to(shineRef.current, {
        xPercent: 400,
        duration: 1.1,
        repeat: -1,
        repeatDelay: 2.6,
        ease: 'power2.inOut',
      })
    }, rootRef)

    return () => ctx.revert()
  }, [])

  function shakeCard() {
    if (!cardRef.current) return
    gsap.fromTo(cardRef.current, { x: -8 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.35)' })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)

    const missing = { username: !username.trim(), password: !password }
    if (missing.username || missing.password) {
      setFieldErrors(missing)
      shakeCard()
      return
    }

    setSubmitting(true)
    const result = await login(username, password)
    setSubmitting(false)
    if (result.ok) {
      onSuccess()
    } else {
      setError(result.error ?? '登录失败')
      shakeCard()
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative flex h-svh items-center justify-center overflow-hidden bg-background px-4 text-foreground"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="aurora-blob absolute top-[-12rem] left-1/2 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-primary/12 blur-[120px]" />
        <div className="aurora-blob absolute right-[-12rem] bottom-[-12rem] h-[26rem] w-[26rem] rounded-full bg-chart-2/10 blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_oklch,var(--foreground)_5%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--foreground)_5%,transparent)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_60%_45%_at_50%_0%,black,transparent)]" />
      </div>

      <form
        ref={cardRef}
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm space-y-6 rounded-2xl border border-border bg-card/90 p-8 shadow-[0_16px_50px_-24px_color-mix(in_oklch,var(--primary)_28%,transparent),0_8px_24px_-12px_rgba(0,0,0,0.1)] backdrop-blur-xl"
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
              onChange={(e) => {
                setUsername(e.target.value)
                if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: false }))
              }}
              disabled={submitting}
              aria-invalid={fieldErrors.username}
              autoFocus
              className="h-10"
            />
            {fieldErrors.username && <p className="text-xs text-destructive">请输入用户名</p>}
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
              onChange={(e) => {
                setPassword(e.target.value)
                if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: false }))
              }}
              disabled={submitting}
              aria-invalid={fieldErrors.password}
              className="h-10"
            />
            {fieldErrors.password && <p className="text-xs text-destructive">请输入密码</p>}
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
          className={cn(
            'relative h-10 w-full overflow-hidden bg-gradient-to-r from-primary to-chart-2 text-primary-foreground shadow-[0_10px_30px_-10px_color-mix(in_oklch,var(--primary)_60%,transparent)] transition-all hover:shadow-[0_14px_36px_-8px_color-mix(in_oklch,var(--primary)_70%,transparent)]',
            incomplete && !submitting && 'opacity-60',
          )}
          disabled={submitting}
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          登录
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
