import { useEffect, useRef, useState } from 'react'
import { Settings, X } from 'lucide-react'
import {
  DEFAULT_AGENT_SETTINGS,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MAX_TURNS,
  MAX_SANDBOX_IDLE_MINUTES,
  MIN_MAX_TURNS,
  MIN_SANDBOX_IDLE_MINUTES,
  MODEL_CHOICES,
  type AgentSettings,
  type ModelChoice,
} from '@autonoma/shared'
import { Button } from '@autonoma/ui/components/button'
import { Input } from '@autonoma/ui/components/input'
import { Textarea } from '@autonoma/ui/components/textarea'
import { getAgentSettings, updateAgentSettings } from '@/lib/settings-api'
import { DialogShell } from './DialogShell'

type LoadState = 'loading' | 'loaded' | 'error'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// 用骨架屏占位而不是"渲染真表单、但整体 disabled"——之前那种做法在数据
// 还没拉回来时，用户看到的是一份填着 DEFAULT_AGENT_SETTINGS 默认值、
// 灰蒙蒙但内容看起来"正常"的表单，容易被误认成已经加载完成的真实设置。
// 骨架条的形状大致对应下面每个字段块的高度，切换到真表单时布局不会跳动。
function SettingsSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-32 rounded-lg bg-muted" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-16 rounded-lg bg-muted" />
        <div className="h-16 rounded-lg bg-muted" />
      </div>
      <div className="space-y-1.5">
        <div className="h-3.5 w-16 rounded-full bg-muted" />
        <div className="h-3.5 w-24 rounded-full bg-muted" />
        <div className="h-3.5 w-20 rounded-full bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-16 rounded-lg bg-muted" />
        <div className="h-16 rounded-lg bg-muted" />
      </div>
      <div className="h-3.5 w-20 rounded-full bg-muted" />
    </div>
  )
}

// 统一的"可点击选项行"样式——原生 radio/checkbox 套一层可悬停的行容器，
// 让整块（不只是那个小圆点/方块）都能点，视觉上也从"裸控件堆叠"变成
// 有边界感的列表项。
const OPTION_ROW = 'flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 text-sm transition-colors hover:bg-muted/60'

export function AgentSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS)
  const value = settings.customInstructions
  function setValue(text: string) {
    setSettings((s) => ({ ...s, customInstructions: text }))
  }
  function update<K extends keyof AgentSettings>(key: K, val: AgentSettings[K]) {
    setSettings((s) => ({ ...s, [key]: val }))
  }
  // 只更新本地展示的数字，不在每次按键时做范围裁剪——裁剪会在用户输入
  // 中途（比如先输入 "2" 再补 "0" 变成 "20"）把值意外锁死在裁剪后的边界上。
  // 真正的范围校验交给保存时的服务端 400（见 index.ts），这里只负责
  // 不让非数字把 state 变成 NaN。空字符串（用户正在清空输入框重新输入）
  // 故意不写回 state——`Number('')` 是 0 不是 NaN，写回去会导致输入框
  // 在被清空的瞬间又立刻被 React 强制渲染回 "0"，用户根本没法清空重打。
  function updateNumber(key: 'maxTurns' | 'sandboxIdleMinutes', raw: string) {
    if (raw === '') return
    const n = Number(raw)
    if (!Number.isNaN(n)) update(key, n)
  }
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [persistedWarning, setPersistedWarning] = useState(false)

  // 挂载时的 effect 和下面 retryLoad 都会发起一次 getAgentSettings()，
  // 两者共用这一个"代次"计数器，而不是各自维护一份局部的 cancelled 标记
  // ——否则 retryLoad 发起的请求没有任何东西能标记它过期：加载失败点了
  // 重试、还没返回前就关闭又重新打开弹窗，挂载 effect 会开始新一轮加载，
  // 但那个还悬着的 retryLoad 请求晚到时会用过期数据把新一轮已经加载好
  // 的内容覆盖掉。每次发起加载前自增并记下当时的代次，结果落地时只有
  // 代次仍然匹配才应用。
  const loadTokenRef = useRef(0)

  // 每次打开都重新拉取最新值——不做本地缓存/未保存改动的二次确认，
  // 保持"打开即最新、关闭不保存草稿"的简单心智模型。
  useEffect(() => {
    if (!open) return
    const token = ++loadTokenRef.current
    setSaveState('idle')
    setErrorMessage(undefined)
    setPersistedWarning(false)
    setLoadState('loading')
    getAgentSettings()
      .then((loaded) => {
        if (loadTokenRef.current !== token) return
        setSettings(loaded)
        setLoadState('loaded')
      })
      .catch(() => {
        if (loadTokenRef.current === token) setLoadState('error')
      })
  }, [open])

  function retryLoad() {
    const token = ++loadTokenRef.current
    setLoadState('loading')
    getAgentSettings()
      .then((loaded) => {
        if (loadTokenRef.current !== token) return
        setSettings(loaded)
        setLoadState('loaded')
      })
      .catch(() => {
        if (loadTokenRef.current === token) setLoadState('error')
      })
  }

  async function handleSave() {
    setSaveState('saving')
    setErrorMessage(undefined)
    const res = await updateAgentSettings(settings)
    if (!res.ok) {
      setSaveState('error')
      setErrorMessage(res.error)
      return
    }
    setSaveState('saved')
    setPersistedWarning(res.persisted === false)
    setTimeout(() => setSaveState('idle'), 1500)
  }

  return (
    <DialogShell open={open} onClose={onClose} variant="compact" labelledBy="agent-settings-title" maxWidthClassName="max-w-xl">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Settings className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1 pt-0.5">
          <h2 id="agent-settings-title" className="text-sm font-semibold">
            Agent 设置
          </h2>
          <p className="text-sm text-muted-foreground">这里的设置会用于你的所有对话，改动立即生效，无需新建会话。</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
          <X className="size-4" />
        </Button>
      </div>

      {loadState === 'loading' ? (
        <SettingsSkeleton />
      ) : loadState === 'error' ? (
        <div className="flex items-center justify-between rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
          加载失败，请重试
          <Button variant="outline" size="sm" onClick={retryLoad}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={MAX_CUSTOM_INSTRUCTIONS_LENGTH}
              placeholder="例如：回复时使用简体中文；代码注释使用英文；给出方案时优先列要点而不是长段落……"
              className="min-h-32 placeholder:text-muted-foreground/50"
            />
            <div className="text-right text-xs text-muted-foreground">
              {value.length}/{MAX_CUSTOM_INSTRUCTIONS_LENGTH}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">审批模式</span>
              <div className="flex flex-col gap-0.5">
                <label className={OPTION_ROW}>
                  <input
                    type="radio"
                    name="approvalMode"
                    className="accent-primary"
                    checked={settings.approvalMode === 'auto'}
                    onChange={() => update('approvalMode', 'auto')}
                  />
                  全自动
                </label>
                <label className={OPTION_ROW}>
                  <input
                    type="radio"
                    name="approvalMode"
                    className="accent-primary"
                    checked={settings.approvalMode === 'confirm'}
                    onChange={() => update('approvalMode', 'confirm')}
                  />
                  危险操作前确认
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="agent-max-turns" className="text-xs font-medium text-muted-foreground">
                单轮最大步数
              </label>
              <Input
                id="agent-max-turns"
                type="number"
                min={MIN_MAX_TURNS}
                max={MAX_MAX_TURNS}
                value={settings.maxTurns}
                onChange={(e) => updateNumber('maxTurns', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {MIN_MAX_TURNS}-{MAX_MAX_TURNS} 之间，越大越能完成复杂任务，但跑飞时消耗也越多
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">工具开关</span>
            <div className="flex flex-col gap-0.5">
              <label className={OPTION_ROW}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={settings.codeExecEnabled}
                  onChange={(e) => update('codeExecEnabled', e.target.checked)}
                />
                代码执行与文件导出
              </label>
              <label className={OPTION_ROW}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={settings.webSearchEnabled}
                  onChange={(e) => update('webSearchEnabled', e.target.checked)}
                />
                联网搜索
              </label>
              <label className={OPTION_ROW}>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={settings.visionEnabled}
                  onChange={(e) => update('visionEnabled', e.target.checked)}
                />
                图片识别
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="agent-model-choice" className="text-xs font-medium text-muted-foreground">
                模型
              </label>
              <select
                id="agent-model-choice"
                value={settings.modelChoice}
                onChange={(e) => update('modelChoice', e.target.value as ModelChoice)}
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              >
                {MODEL_CHOICES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {MODEL_CHOICES.find((m) => m.value === settings.modelChoice)?.description}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="agent-sandbox-idle" className="text-xs font-medium text-muted-foreground">
                沙箱空闲保留时长（分钟）
              </label>
              <Input
                id="agent-sandbox-idle"
                type="number"
                min={MIN_SANDBOX_IDLE_MINUTES}
                max={MAX_SANDBOX_IDLE_MINUTES}
                value={settings.sandboxIdleMinutes}
                onChange={(e) => updateNumber('sandboxIdleMinutes', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {MIN_SANDBOX_IDLE_MINUTES}-{MAX_SANDBOX_IDLE_MINUTES} 之间，决定同一会话的沙箱在两条消息之间能保留多久
              </p>
            </div>
          </div>

          <label className={OPTION_ROW}>
            <input
              type="checkbox"
              className="accent-primary"
              checked={settings.conciseReplies}
              onChange={(e) => update('conciseReplies', e.target.checked)}
            />
            简洁回复
          </label>
        </>
      )}

      {persistedWarning && <p className="text-xs text-muted-foreground">当前处于免登录模式，这条设置不会被保存。</p>}
      {saveState === 'error' && errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={loadState !== 'loaded' || saveState === 'saving'}>
          {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : '保存'}
        </Button>
      </div>
    </DialogShell>
  )
}
