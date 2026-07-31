import OpenAI from 'openai'

export const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

// Some models get rate-limited or de-listed on OpenRouter without notice —
// keep this an env var so swapping models doesn't need a code change.
export const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro'
