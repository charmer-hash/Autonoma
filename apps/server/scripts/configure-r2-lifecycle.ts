import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3'
import { getBucket, getClient } from '../src/lib/storage.js'

// 一次性手动运行（R2 桶创建好之后跑一次即可）——桶级别的生命周期规则
// 不需要跟着每次部署重新应用，所以不放进 runMigrations() 那种启动时
// 自动执行的路径。uploads/（用户上传的原始文件）比 artifacts/（Agent
// 生成给用户下载的产物）留得短：前者只是 Agent 处理任务的输入，沙箱本身
// 只有几分钟到几十分钟的 TTL；后者是用户可能主动要下载留存的东西。
await getClient().send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: getBucket(),
    LifecycleConfiguration: {
      Rules: [
        { ID: 'expire-uploads', Status: 'Enabled', Filter: { Prefix: 'uploads/' }, Expiration: { Days: 30 } },
        { ID: 'expire-artifacts', Status: 'Enabled', Filter: { Prefix: 'artifacts/' }, Expiration: { Days: 90 } },
      ],
    },
  }),
)
console.log('R2 生命周期规则已配置：uploads/ 30 天过期，artifacts/ 90 天过期。')
process.exit(0)
