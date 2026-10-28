import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiStatus } from '../../shared/api'
import type { AiClient } from './aiClient'
import { httpAiClient } from './aiClient'
import * as db from './db'
import { recoverInterrupted } from './recorder'
import type { Draft, Note } from './types'

export interface ToastMsg {
  id: number
  text: string
  kind: 'ok' | 'error'
}
interface Ctx {
  notes: Note[]
  loaded: boolean
  storageError: string | null
  drafts: Draft[]
  reload: () => Promise<void>
  /** 다른 탭에 변경을 알린다 */
  announce: (noteId: string, revision: number) => void
  onRemoteChange: (fn: (noteId: string, revision: number) => void) => () => void
  ai: AiStatus | null
  aiError: string | null
  refreshAi: () => Promise<void>
  client: AiClient
  toast: (text: string, kind?: 'ok' | 'error') => void
  toasts: ToastMsg[]
}
const C = createContext<Ctx | null>(null)
export const useApp = (): Ctx => {
  const v = useContext(C)
  if (!v) throw new Error('AppProvider 밖에서 사용했습니다.')
  return v
}

export function AppProvider({ children, client = httpAiClient }: { children: ReactNode; client?: AiClient }) {
  const [notes, setNotes] = useState<Note[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loaded, setLoaded] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const chan = useRef<BroadcastChannel | null>(null)
  const listeners = useRef(new Set<(id: string, rev: number) => void>())

  const reload = useCallback(async () => {
    try {
      const [n, d] = await Promise.all([db.listNotes(), db.listDrafts()])
      setNotes(n)
      setDrafts(d)
      setStorageError(null)
    } catch (e) {
      setStorageError((e as Error).message)
    } finally {
      setLoaded(true)
    }
  }, [])

  const refreshAi = useCallback(async () => {
    try {
      setAi(await client.status())
      setAiError(null)
    } catch {
      setAi(null)
      setAiError('AI 서버에 연결하지 못했습니다. 직접 작성·저장은 그대로 사용할 수 있어요.')
    }
  }, [client])

  useEffect(() => {
    void (async () => {
      try {
        await recoverInterrupted()
      } catch {
        /* 복구 실패는 목록 로딩을 막지 않는다 */
      }
      await reload()
    })()
    void refreshAi()
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel('thinkbaro')
      ch.onmessage = (e: MessageEvent<{ id: string; rev: number }>) => {
        void reload()
        listeners.current.forEach((f) => f(e.data.id, e.data.rev))
      }
      chan.current = ch
      return () => ch.close()
    }
  }, [reload, refreshAi])

  const announce = useCallback((id: string, rev: number) => chan.current?.postMessage({ id, rev }), [])
  const onRemoteChange = useCallback((fn: (id: string, rev: number) => void) => {
    listeners.current.add(fn)
    return () => void listeners.current.delete(fn)
  }, [])

  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3200)
  }, [])

  const value = useMemo<Ctx>(
    () => ({ notes, loaded, storageError, drafts, reload, announce, onRemoteChange, ai, aiError, refreshAi, client, toast, toasts }),
    [notes, loaded, storageError, drafts, reload, announce, onRemoteChange, ai, aiError, refreshAi, client, toast, toasts],
  )
  return <C.Provider value={value}>{children}</C.Provider>
}
