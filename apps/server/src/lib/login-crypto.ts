import { generateKeyPairSync, privateDecrypt, constants as cryptoConstants } from 'node:crypto'

// 密码在 POST /api/auth/login 请求体里必须以密文形式出现——即使部署在
// HTTPS 之下、传输层本身已经加密，安全测评/等保扫描仍然会按请求体
// 明文内容判定"密码明文传输"，因为它们看的是应用层payload，不关心
// TLS。这里补一层应用层的非对称加密：前端用这把公钥加密密码，
// 只有持有私钥的这台服务器能解出来。
//
// 密钥对是进程启动时随机生成、只留在内存里的（不落盘、不进环境变量）——
// 这只是"别把密码明文塞进请求体"这一项合规要求的解法，不是长期身份
// 凭证，重启后旧密钥失效完全没问题：前端每次登录前都会重新拉取当前
// 公钥。唯一的代价是多实例横向扩展时各实例公钥不一致——这个项目目前
// 是单实例部署（Railway 单个服务），如果之后需要多实例，把这对密钥
// 换成从环境变量读取固定值即可，不用改调用方的任何代码。
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})

const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })

export function getPublicKeyBase64(): string {
  return publicKeyDer.toString('base64')
}

// 密码上限对齐前端 Web Crypto 用的 RSA-OAEP/SHA-256 在 2048 位密钥下的
// 最大明文长度（256 - 2*32 - 2 = 190 字节）——任何真实密码都远小于这个
// 数，唯一会撞到这个上限的只可能是格式不对/被篡改的密文，不需要单独
// 校验，交给下面的 privateDecrypt 直接报错即可。
//
// 抛出的错误信息刻意不区分"密文格式不对"和"公钥已经轮换过"（服务端
// 重启会换一把新密钥）——两种情况前端的应对方式相同：刷新页面重新
// 拿一次公钥再登录一次。
export function decryptPassword(encryptedBase64: unknown): string {
  if (typeof encryptedBase64 !== 'string' || !encryptedBase64) {
    throw new Error('登录请求格式不正确，请刷新页面重试。')
  }
  try {
    const decrypted = privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encryptedBase64, 'base64'),
    )
    return decrypted.toString('utf8')
  } catch {
    throw new Error('登录请求已过期或已损坏，请刷新页面重试。')
  }
}
