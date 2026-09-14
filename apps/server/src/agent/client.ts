import OpenAI from 'openai'
import type { ModelChoice } from '@autonoma/shared'

export const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

// 部分模型在 OpenRouter 上可能会被限流或未经通知就下架——
// 因此把它做成环境变量，方便切换模型时无需改代码。
export const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro'

// 历史压缩只需要把旧对话整理成简短摘要，不需要占用正式回答模型。
// 单独配置可以降低首 token 延迟和摘要成本。
export const COMPACTION_MODEL = process.env.OPENROUTER_COMPACTION_MODEL ?? 'deepseek/deepseek-v3.2'

// MODEL 只支持文本（DeepSeek 在 OpenRouter 上不支持视觉输入）——
// 任何需要让模型看图片的 LLM 调用都会改用这个模型，
// 且仅限那一次调用。参见 loop.ts 中按轮次选择模型的逻辑。
//
// 默认选 qwen3-vl-235b-a22b-instruct 而不是 claude-sonnet-5/gpt-5.1/gemini：
// 实测这个 OpenRouter 账号调用 Anthropic/OpenAI/Google 的模型（哪怕是纯
// 文本请求）都会收到 403 "violation of provider Terms Of Service"——账号
// 所在地区被这几家限制访问，不是账号验证之类临时问题，也不是这几个模型
// 本身有问题。实测 x-ai/grok-4.5、z-ai/glm-4.6v、qwen3-vl 系列在同一账号
// 下都能正常调用，且中文 OCR 效果（同一张发票图片测试）完全一致；选
// Qwen3-VL-235B 是因为它是这几个能用的选项里价格最低的一档（比 grok-4.5
// 便宜约 10 倍），阿里的模型，不存在前面那种地区限制的风险。如果想换，
// 改 OPENROUTER_VISION_MODEL 环境变量即可，不用改代码。
export const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? 'qwen/qwen3-vl-235b-a22b-instruct'

// Agent 设置里"模型"这一档的备选项——同一账号下已验证能正常调用（见上面
// VISION_MODEL 的说明：Anthropic/OpenAI/Google 系列在这个账号所在地区会
// 403），不开放白名单以外的任意字符串，避免用户传一个会直接报错的模型 id。
export const GROK_MODEL = 'x-ai/grok-4.5'

export function resolveModel(choice: ModelChoice): string {
  return choice === 'grok' ? GROK_MODEL : MODEL
}
