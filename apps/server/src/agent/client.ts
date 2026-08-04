import OpenAI from 'openai'

export const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

// 部分模型在 OpenRouter 上可能会被限流或未经通知就下架——
// 因此把它做成环境变量，方便切换模型时无需改代码。
export const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro'

// MODEL 只支持文本（DeepSeek 在 OpenRouter 上不支持视觉输入）——
// 任何需要让模型看图片的 LLM 调用都会改用这个模型，
// 且仅限那一次调用。参见 loop.ts 中按轮次选择模型的逻辑。
//
// 默认选 grok-4.5 而不是 claude-sonnet-5/gpt-5.1/gemini：实测这个
// OpenRouter 账号调用 Anthropic/OpenAI/Google 的模型（哪怕是纯文本请求）
// 都会收到 403 "violation of provider Terms Of Service"——这是 OpenRouter
// 账号级别的限制（这些 provider 要求额外的身份验证），不是这几个模型
// 本身有问题。如果账号完成验证后想换回更强的视觉模型，改
// OPENROUTER_VISION_MODEL 环境变量即可，不用改代码。
export const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? 'x-ai/grok-4.5'
