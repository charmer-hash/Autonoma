import type { AgentEvent } from '@autonoma/shared'

// 按 sessionId 登记"当前是否有一条正在执行的 agent 运行"——同时充当两件事：
// 1. 并发锁：同一个 session 同时只允许一条运行（见 index.ts 里 POST /api/agent/run
//    的 tryStartRun 调用），避免两个请求同时连接/操作同一个沙箱。
// 2. 事件缓冲区：客户端的 SSE 连接中途断开后，服务端本来就会把这一轮跑完并落库
//    （Hono 的 streamSSE 在写入已断开的连接时会静默吞掉异常，不会让 runAgentLoop
//    提前退出），只是断线期间产生的事件客户端看不到——这里把每个事件按 seq 缓存下来，
//    断线的客户端重连后可以从自己记得的最后一个 seq 继续补收。
//
// 纯内存态、单进程——和 approvals.ts 的等待中批准 Map、sessions.sandboxId 的
// 内存态生命周期是同一类"单实例部署下可接受"的设计,不做跨进程持久化。

type BufferedEvent = { seq: number; event: AgentEvent }
// 返回值允许是 Promise——attachSink 的补发循环需要在返回给调用方之前
// 等真正写完（见下面 attachSink 的注释），publish() 的实时分发路径则
// 不等待，两者用的是同一个 sink 函数引用。
type Sink = (buffered: BufferedEvent) => void | Promise<void>

type ActiveRun = {
  // 每条 run 唯一的身份标识(和 sessionId 是两回事——sessionId 在一个会话
  // 的生命周期内不变，而同一个 session 会顺序跑很多条 run)。存在的唯一
  // 目的是让 attachSink 能识别出"Map 里 sessionId 对应的这条记录，是不是
  // 我当初想重连的那一条"，而不是同一个 sessionId 下之后又开始的新一轮
  // ——见 attachSink 的注释。
  id: string
  events: BufferedEvent[]
  nextSeq: number
  sinks: Set<Sink>
  finished: boolean
  finishWaiters: Set<() => void>
  cancelled: boolean
  controller: AbortController
}

const runs = new Map<string, ActiveRun>()

// run 结束后事件缓冲区还保留多久,供极晚才重连的客户端补读——之后从 Map 里删除,
// 重连请求会看到"没有活跃 run",退回到直接读取持久化历史的兜底路径。
const FINISHED_RUN_GRACE_MS = 2 * 60_000

// DELETE /api/sessions/:id 在真正执行数据库删除之前先同步标记这里——
// isRunInProgress 检查和 deleteSession 之间隔着一次 await，如果不在检查
// 的同一个同步块里把这个 session "预定"下来，另一个标签页完全可能在
// 这段 await 期间调用 tryStartRun（纯同步操作）抢先开始新一轮对话，
// 等它后续 appendMessages 落库时，会话行已经被删除，撞外键失败。这个
// Set 和上面的检查、下面 tryStartRun 里的检查都是纯同步操作，中间没有
// 任何 await 空隙，所以能真正堵住这个竞态窗口。
const deletingSessions = new Set<string>()

// 已存在一条尚未 finished 的 run、或者这个 session 正在被删除时返回
// undefined——这就是并发锁本身,调用方应据此拒绝新请求。已经 finished、
// 只是还留在宽限期内等迟到的重连请求补读的旧记录不算"活跃",这里会直接
// 用一条全新的记录覆盖掉它。成功时返回这条新记录的 id，调用方需要把它
// 带在 SSE 帧里发给客户端（见 index.ts），客户端重连时要把它原样带回来，
// 见 attachSink 的注释。
export function tryStartRun(sessionId: string): string | undefined {
  if (deletingSessions.has(sessionId)) return undefined
  const existing = runs.get(sessionId)
  if (existing && !existing.finished) return undefined
  const id = crypto.randomUUID()
  runs.set(sessionId, { id, events: [], nextSeq: 0, sinks: new Set(), finished: false, finishWaiters: new Set(), cancelled: false, controller: new AbortController() })
  return id
}

export function cancelRun(sessionId: string): boolean {
  const run = runs.get(sessionId)
  if (!run || run.finished) return false
  run.cancelled = true
  run.controller.abort()
  publish(sessionId, { type: 'stopped' })
  return true
}

export function getRunSignal(sessionId: string, runId: string): AbortSignal | undefined {
  const run = runs.get(sessionId)
  return run?.id === runId ? run.controller.signal : undefined
}

export function isRunCancelled(sessionId: string): boolean {
  return runs.get(sessionId)?.cancelled ?? false
}

// 调用方（DELETE /api/sessions/:id）必须先同步调用 isRunInProgress 确认
// 没有活跃 run，紧接着、不隔任何 await 地调用这个函数完成"预定"，再去
// await 真正的数据库删除——两次调用之间必须没有 await，否则起不到关闭
// 竞态窗口的作用。数据库删除无论成功与否都必须调用 clearSessionDeleting
// 收尾：成功时是为了防止 sessionId 万一被复用（当前实现下不会，但不依赖
// 这个假设）；失败时是为了不让这个 session 从此再也无法开始新的一轮。
export function markSessionDeleting(sessionId: string): void {
  deletingSessions.add(sessionId)
}

export function clearSessionDeleting(sessionId: string): void {
  deletingSessions.delete(sessionId)
}

// 供 reconnect 路由在决定要不要进入 SSE 之前做一次同步判断——这里的"active"
// 故意包含了已经 finished、只是还在宽限期内等迟到重连请求补读的记录，
// 因为重连场景本来就需要对这种记录做一次性重放。runId 必须匹配：如果
// Map 里 sessionId 对应的已经是后续开始的新一轮（旧的那条已经被
// tryStartRun 用新记录覆盖掉），这里要按"客户端想重连的那条 run 已经不在
// 了"处理，而不是把新一轮的内容错当成旧一轮的续集发给它。
export function isRunActive(sessionId: string, runId: string): boolean {
  return runs.get(sessionId)?.id === runId
}

// 严格意义上"这一轮还没跑完"，不包含宽限期内的旧记录——供不该被已完成
// run 挡住的场景使用（比如判断能不能删除一个会话：一轮消息刚跑完、还
// 在 2 分钟宽限期里的会话应该能正常删除，不能被误伤）。
export function isRunInProgress(sessionId: string): boolean {
  const run = runs.get(sessionId)
  return !!run && !run.finished
}

export function publish(sessionId: string, event: AgentEvent): void {
  const run = runs.get(sessionId)
  if (!run) return
  const buffered: BufferedEvent = { seq: run.nextSeq++, event }
  run.events.push(buffered)
  // 故意不等待每个 sink 真正写完——这里在 runAgentLoop 的事件循环里，
  // 一个慢/卡住的客户端连接不该拖慢 agent 本身的执行。sink 返回的
  // Promise 只在下面 catch 掉，避免变成未处理的 rejection，不代表
  // 忽略写入失败——写入失败已经在各 sink 实现自己的 write() 里处理过了。
  for (const sink of run.sinks) {
    Promise.resolve(sink(buffered)).catch(() => {})
  }
}

// 先补发 afterSeq 之后已经发生过的历史事件,再注册为活跃 sink 继续接收后续事件
// (除非这个 run 已经 finished,那样就没有"后续"了)。返回 undefined 表示
// sessionId 对应的当前这条 run 的 id 跟调用方要重连的 runId 对不上——要么
// 从没跑过，要么已经过了宽限期被清理，要么（关键的一种情况）宽限期内同一个
// session 已经开始了下一轮全新的 run，Map 里的记录已经换了身份。
//
// runId 这个身份校验是必须的，不能只按 sessionId 查——同一个 sessionId 在
// 它的生命周期里会顺序对应很多条不同的 run，seq 计数器在每条新 run 里都从 0
// 重新开始。如果只按 sessionId 找、不比对 run 的身份，一个还在按退避序列重试
// 重连上一条 run（比如 afterSeq=8）的客户端，可能会在这期间 Map 被下一条新
// run（events 都是全新的，seq 也从 0 开始）覆盖掉之后，把 afterSeq=8 拿去跟
// 新 run 的事件比较——只要新 run 也发出了 9 个以上事件，这个比较一样会
// "通过"，导致客户端在毫无提示的情况下，把完全不相关的新一轮内容当成
// 上一轮的续集收下（错误内容拼接，而不只是丢事件）。
//
// 补发循环这里必须 await 每一次 sink()——不然调用方（reconnect 路由）在
// "已 finished、补发完就直接 return"的分支里，会在 writeSSE 真正把数据
// 写进底层 writer 之前就返回，Hono 的 streamSSE 会在 handler 返回后立刻
// close() 这个 writer，导致还没来得及写完的补发事件被静默丢弃
// （StreamingApi.write() 内部会吞掉写入已关闭 writer 时抛出的异常）。
export async function attachSink(
  sessionId: string,
  runId: string,
  afterSeq: number,
  sink: Sink,
): Promise<{ finished: boolean } | undefined> {
  const run = runs.get(sessionId)
  if (!run || run.id !== runId) return undefined
  for (const buffered of run.events) {
    if (buffered.seq > afterSeq) await sink(buffered)
  }
  if (!run.finished) run.sinks.add(sink)
  return { finished: run.finished }
}

export function detachSink(sessionId: string, sink: Sink): void {
  runs.get(sessionId)?.sinks.delete(sink)
}

// 已经 finished 时立即 resolve,否则等下一次 finishRun 唤醒——reconnect 路由用它
// 把连接挂住,直到这一轮真正跑完。
export function waitForFinish(sessionId: string): Promise<void> {
  const run = runs.get(sessionId)
  if (!run || run.finished) return Promise.resolve()
  return new Promise((resolve) => run.finishWaiters.add(resolve))
}

export function finishRun(sessionId: string): void {
  const run = runs.get(sessionId)
  if (!run) return
  run.finished = true
  run.sinks.clear()
  for (const resolve of run.finishWaiters) resolve()
  run.finishWaiters.clear()
  // 按身份而不是单纯按 sessionId 删除——如果这条 run 结束后、宽限期内
  // 同一个 session 又开始了新的一轮（tryStartRun 会用新记录覆盖掉这条
  // 已 finished 的旧记录），这个定时器不能把 map 里已经是新 run 的记录
  // 删掉，否则新一轮还在进行中的事件从此再也发不出去，且没有任何报错。
  setTimeout(() => {
    if (runs.get(sessionId) === run) runs.delete(sessionId)
  }, FINISHED_RUN_GRACE_MS)
}
