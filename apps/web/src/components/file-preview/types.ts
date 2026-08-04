// 用延迟求值而不是普通字符串：解析出实际 URL 需要发起一次 API 调用
// （GET /api/artifacts/:id?raw=1——参见 lib/artifacts-api.ts），而
// FilePreview 应该等到真正挂载/显示时才触发这次调用。
export type FilePreviewSource = {
  name: string
  mimeType: string
  resolveUrl: () => Promise<string>
}
