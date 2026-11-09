import { useEffect, useState } from 'react'
import { BookOpen, Loader2, Plus, Trash2, Upload, X } from 'lucide-react'
import { createR2UploadAdapter } from '@autonoma/upload/lib/upload'
import { Button } from '@autonoma/ui/components/button'
import { Input } from '@autonoma/ui/components/input'
import { cn } from '@autonoma/ui/lib/utils'
import { getUploadUrl } from '@/lib/uploads-api'
import { API_URL } from '@/lib/api-client'
import { addDocument, createBase, deleteBase, deleteDocument, listBases, listDocuments, reindexDocument, replaceDocument, retryDocument, searchAllBases, searchBase, type KnowledgeBase, type KnowledgeDocument, type KnowledgeHit } from '@/lib/knowledge-api'
import { DialogShell } from './DialogShell'

const uploader = createR2UploadAdapter({ getUploadUrl, validation: { maxSizeBytes: 20 * 1024 * 1024 } })
const allowed = /\.(pdf|docx|md|markdown|txt)$/i

export function KnowledgeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [baseId, setBaseId] = useState(() => localStorage.getItem('knowledgeBaseId') ?? '')
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState<{ sources: KnowledgeHit[]; warning?: string } | null>(null)
  const [mode, setMode] = useState(() => localStorage.getItem('knowledgeMode') ?? 'auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function refreshBases() {
    const result = await listBases()
    setBases(result.bases)
    if (baseId && !result.bases.some((b) => b.id === baseId)) selectBase('')
  }
  async function refreshDocuments(id = baseId) {
    if (id) setDocuments((await listDocuments(id)).documents)
    else setDocuments([])
  }
  function selectBase(id: string) {
    setBaseId(id)
    setSearchResult(null)
    if (id) localStorage.setItem('knowledgeBaseId', id)
    else localStorage.removeItem('knowledgeBaseId')
  }
  async function action(fn: () => Promise<void>) {
    setError('')
    setBusy(true)
    try { await fn() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (open) void action(refreshBases)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (open) void refreshDocuments().catch((err) => setError(String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId, open])
  useEffect(() => {
    if (!open || !baseId || !documents.some((d) => d.pendingVersion && !d.errorMessage)) return
    const timer = window.setInterval(() => void refreshDocuments().catch(() => {}), 3000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId, open, documents])

  async function upload(files: FileList | null, replacementId?: string) {
    if (!files || !baseId) return
    await action(async () => {
      for (const file of Array.from(files)) {
        if (!allowed.test(file.name)) throw new Error('仅支持 PDF、DOCX、Markdown 和 TXT。')
        const { key } = await uploader.upload(file)
        if (replacementId) await replaceDocument(replacementId, key, file)
        else await addDocument(baseId, key, file)
      }
      await refreshDocuments()
    })
  }

  return <DialogShell open={open} onClose={onClose} variant="large" label="知识库" maxWidthClassName="max-w-3xl">
    <div className="flex items-center justify-between border-b px-5 py-4">
      <div className="flex items-center gap-2"><BookOpen className="size-5 text-primary" /><h2 className="font-semibold">知识库</h2></div>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭"><X className="size-4" /></Button>
    </div>
    <div className="space-y-5 overflow-y-auto p-5 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-44 flex-1 space-y-1"><span className="text-muted-foreground">当前知识库</span>
          <select className="h-9 w-full rounded-md border bg-background px-2" value={baseId} onChange={(e) => selectBase(e.target.value)}>
            <option value="">全部知识库</option>{bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
          </select>
        </label>
        <label className="min-w-44 flex-1 space-y-1"><span className="text-muted-foreground">新建知识库</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：产品文档" maxLength={100} />
        </label>
        <Button disabled={busy || !name.trim()} onClick={() => void action(async () => {
          const { base } = await createBase(name.trim()); setName(''); await refreshBases(); selectBase(base.id)
        })}><Plus className="mr-1 size-4" />新建</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <label className="flex items-center gap-2">回答时检索
          <select className="rounded-md border bg-background px-2 py-1" value={mode} onChange={(e) => {
            setMode(e.target.value); localStorage.setItem('knowledgeMode', e.target.value)
          }}><option value="auto">按需</option><option value="required">每次先检索</option><option value="off">关闭</option></select>
        </label>
        <span className="text-xs text-muted-foreground">选择知识库后，Agent 仅在该库内检索；不选择则搜索全部。</span>
      </div>
      {!baseId && <div className="rounded-lg border bg-muted/20 p-4">
        <p className="font-medium">检索全部知识库</p>
        <p className="mt-1 text-muted-foreground">在下方输入问题，可搜索所有已完成索引的文档。选择一个知识库后可管理其中的文件。</p>
        {bases.length === 0 && <p className="mt-2 text-muted-foreground">还没有知识库，可先在上方新建。</p>}
      </div>}
      {baseId && <>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">文档 · {documents.length}</h3>
          <div className="flex items-center gap-2">
            <label className={cn('inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-primary-foreground focus-within:ring-2 focus-within:ring-ring/60', busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-primary/90')}><Upload className="size-4" />上传文件<input type="file" multiple accept=".pdf,.docx,.md,.markdown,.txt" className="sr-only" disabled={busy} onChange={(e) => { void upload(e.target.files); e.target.value = '' }} /></label>
            <Button variant="outline" size="icon-lg" aria-label="删除当前知识库" disabled={busy} onClick={() => void action(async () => {
              if (!window.confirm('删除整个知识库及所有文档？')) return
              await deleteBase(baseId); selectBase(''); await refreshBases()
            })}><Trash2 className="size-4" /></Button>
          </div>
        </div>
        <div className="divide-y rounded-lg border">{documents.length === 0 ? <p className="p-4 text-muted-foreground">还没有文档。上传 PDF、Word、Markdown 或 TXT 开始索引。</p> : documents.map((doc) =>
          <div key={doc.id} className="flex flex-wrap items-center gap-2 p-3">
            {doc.status === 'ready' ? <a className="min-w-0 flex-1 truncate text-primary hover:underline" href={`${API_URL}/api/knowledge/documents/${doc.id}/source`} target="_blank" rel="noreferrer">{doc.filename}</a> : <span className="min-w-0 flex-1 truncate">{doc.filename}</span>}
            <span className="text-xs text-muted-foreground">{doc.errorMessage ? '导入失败' : doc.pendingVersion ? '索引中' : doc.status === 'ready' ? `${doc.chunkCount} 片段` : '等待处理'}</span>
            {doc.errorMessage && <span className="basis-full text-xs text-destructive">{doc.errorMessage}</span>}
            {doc.errorMessage && <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void action(async () => { await retryDocument(doc.id); await refreshDocuments() })}>重试</Button>}
            {doc.status === 'ready' && !doc.pendingVersion && <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void action(async () => { await reindexDocument(doc.id); await refreshDocuments() })}>重建索引</Button>}
            <label className={cn('inline-flex h-8 items-center rounded-md border px-2.5 text-xs focus-within:ring-2 focus-within:ring-ring/60', busy || doc.pendingVersion ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-muted')} >替换<input type="file" accept=".pdf,.docx,.md,.markdown,.txt" className="sr-only" disabled={busy || !!doc.pendingVersion} onChange={(e) => { void upload(e.target.files, doc.id); e.target.value = '' }} /></label>
            <button type="button" className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} aria-label={`删除 ${doc.filename}`} onClick={() => void action(async () => { if (window.confirm(`删除「${doc.filename}」？`)) { await deleteDocument(doc.id); await refreshDocuments() } })}><Trash2 className="size-4" /></button>
          </div>)}</div>
      </>}
      <div className="space-y-2">
        <h3 className="font-medium">测试检索</h3>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void action(async () => setSearchResult(await (baseId ? searchBase(baseId, query.trim()) : searchAllBases(query.trim())))) }}>
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setSearchResult(null) }} aria-label="检索知识库" placeholder="输入问题或关键词" /><Button type="submit" disabled={busy || !query.trim()}>检索</Button>
        </form>
        {searchResult && <div aria-live="polite" className="space-y-2 pt-1">
          {searchResult.warning && <p className="text-amber-600 dark:text-amber-400">{searchResult.warning}</p>}
          {searchResult.sources.length === 0 && <p className="text-muted-foreground">未找到相关内容，请尝试其他问题或关键词。</p>}
          {searchResult.sources.map((hit) => <div key={hit.ref} className="rounded-lg border p-3"><a className="font-medium text-primary hover:underline" href={`${API_URL}/api/knowledge/documents/${hit.documentId}/source`} target="_blank" rel="noreferrer">[{hit.ref}] {hit.filename}{hit.pageNumber ? ` · 第 ${hit.pageNumber} 页` : ''}</a><p className="mt-2 whitespace-pre-wrap text-muted-foreground">{hit.content}</p></div>)}
        </div>}
      </div>
      {busy && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />处理中…</p>}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  </DialogShell>
}
