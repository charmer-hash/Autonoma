import type OpenAI from 'openai'
import { withRetry } from '../../lib/retry.js'

interface TavilyResult {
  title: string
  url: string
  content: string
}

export const searchTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索当前的真实世界信息——价格、地址、电话号码、营业时间、新闻，' +
        '或任何你凭记忆无法确定的内容。在计划或建议中陈述这类具体事实之前，必须先搜索；绝不能编造。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词。' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '读取指定网页的正文内容。通常先使用 web_search 找到 URL，再用此工具获取页面详情。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要读取的完整 http(s) 网页地址。' } },
        required: ['url'],
      },
    },
  },
]

export const searchToolHandlers: Record<string, (args: unknown) => Promise<string>> = {
  web_search: async (args) => {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) {
      return JSON.stringify({ error: '联网搜索未配置（缺少 TAVILY_API_KEY）。' })
    }

    const query = String((args as { query?: unknown })?.query ?? '')

    let res: Response
    try {
      res = await withRetry(async () => {
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
        })
        // 只对服务端/临时性故障重试；4xx（key 错误、请求错误）
        // 重试也不会自愈，所以直接立即报出来，而不是干等着重试。
        if (!r.ok && r.status >= 500) throw new Error(`search upstream ${r.status}`)
        return r
      })
    } catch {
      return JSON.stringify({ error: '搜索服务暂时不可用，请稍后重试。' })
    }

    if (!res.ok) {
      return JSON.stringify({ error: `搜索失败：${res.status} ${res.statusText}` })
    }

    const data = (await res.json()) as { results?: TavilyResult[] }
    const results = (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }))
    return JSON.stringify({ results })
  },
  web_fetch: async (args) => {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) return JSON.stringify({ error: '网页抓取未配置（缺少 TAVILY_API_KEY）。' })
    const url = String((args as { url?: unknown })?.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return JSON.stringify({ error: 'URL 必须以 http:// 或 https:// 开头。' })
    let res: Response
    try {
      res = await withRetry(async () => {
        const r = await fetch('https://api.tavily.com/extract', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, urls: [url], format: 'markdown' }),
        })
        if (!r.ok && r.status >= 500) throw new Error(`extract upstream ${r.status}`)
        return r
      })
    } catch {
      return JSON.stringify({ error: '网页抓取服务暂时不可用，请稍后重试。' })
    }
    if (!res.ok) return JSON.stringify({ error: `网页抓取失败：${res.status} ${res.statusText}` })
    const data = (await res.json()) as { results?: Array<{ url?: string; raw_content?: string }> }
    const item = data.results?.[0]
    if (!item?.raw_content) return JSON.stringify({ error: '网页没有返回可读取的正文内容。', url })
    return JSON.stringify({ url: item.url ?? url, content: item.raw_content.slice(0, 50_000) })
  },
}
