import { useEffect, useState } from 'react'
import type { NoteType } from './types'

export type Route =
  | { name: 'home' }
  | { name: 'settings' }
  | { name: 'new'; type: NoteType }
  | { name: 'note'; id: string }
  | { name: 'record'; type: NoteType; noteId?: string }

const isType = (v: string | undefined): v is NoteType => v === 'memo' || v === 'idea' || v === 'story'

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?')
  const seg = path.split('/').filter(Boolean)
  const q = new URLSearchParams(query)
  if (seg[0] === 'settings') return { name: 'settings' }
  if (seg[0] === 'new') return { name: 'new', type: isType(seg[1]) ? seg[1] : 'memo' }
  if (seg[0] === 'note' && seg[1]) return { name: 'note', id: decodeURIComponent(seg[1]) }
  if (seg[0] === 'record') return { name: 'record', type: isType(seg[1]) ? seg[1] : 'memo', noteId: q.get('note') ?? undefined }
  return { name: 'home' }
}

export const href = {
  home: () => '#/',
  settings: () => '#/settings',
  new: (t: NoteType) => `#/new/${t}`,
  note: (id: string) => `#/note/${encodeURIComponent(id)}`,
  record: (t: NoteType, noteId?: string) => `#/record/${t}${noteId ? `?note=${encodeURIComponent(noteId)}` : ''}`,
}

export function go(h: string): void {
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else location.hash = h
}

/** 이력을 쌓지 않고 주소만 바꾼다(새 글을 처음 저장했을 때). */
export function replace(h: string): void {
  history.replaceState(null, '', h)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parseHash(location.hash))
  useEffect(() => {
    const f = () => setR(parseHash(location.hash))
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return r
}
