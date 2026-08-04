import type { PublicKeyResponse } from '@autonoma/shared'
import { apiFetch } from './api-client'

// 每次登录都现拿一次公钥，不缓存——服务端的密钥对是进程内存里生成的
// 临时密钥（见 apps/server/src/lib/login-crypto.ts），重启就会换一把，
// 现拿能保证用的永远是服务端当前持有私钥的那一把，不用额外处理
// "缓存的公钥已经过期"这种情况。
async function fetchPublicKey(): Promise<CryptoKey> {
  const res = await apiFetch('/api/auth/public-key')
  if (!res.ok) throw new Error('无法获取加密公钥，请检查网络后重试。')
  const { publicKey } = (await res.json()) as PublicKeyResponse

  const der = Uint8Array.from(atob(publicKey), (ch) => ch.charCodeAt(0))
  return crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

// 登录请求体里的密码字段永远是这个函数的返回值（RSA-OAEP 加密后的
// 密文，base64），从不是明文——即使部署在 HTTPS 之下，安全测评/等保
// 扫描通常按请求体本身的内容判断"密码是否明文传输"，不会去区分
// 传输层是否已经加密。
export async function encryptPassword(password: string): Promise<string> {
  const key = await fetchPublicKey()
  const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(password))
  return toBase64(encrypted)
}
