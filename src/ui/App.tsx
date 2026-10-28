import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { focusHeading, markNavigated } from '../lib/focus'
import { go, href, useRoute } from '../lib/router'
import { AppProvider, useApp } from '../lib/store'
import { newId, NOTE_TYPES, TYPE_META } from '../lib/types'
import { FILTER_LABEL, Home } from './Home'
import type { Filter, ViewState } from './Home'
import { Icon } from './Icon'
import { NoteScreen } from './NoteScreen'
import { RecordScreen } from './RecordScreen'
import { Settings } from './Settings'

const LAYOUT_KEY = 'thinkbaro-layout'
const readLayout = (): ViewState['layout'] => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function Shell() {
  const route = useRoute()
  const { toasts } = useApp()
  const [view, setViewState] = useState<ViewState>({ filter: 'all', query: '', sort: 'recent', layout: readLayout() })
  const main = useRef<HTMLElement>(null)
  const setView = useCallback((p: Partial<ViewState>) => {
    setViewState((v) => ({ ...v, ...p }))
    if (p.layout) {
      try {
        localStorage.setItem(LAYOUT_KEY, p.layout)
      } catch {
        /* 저장이 막혀 있어도 화면은 동작한다 */
      }
    }
  }, [])

  // 새 글은 주소로 들어올 때마다 새 id를 받는다. 첫 저장 뒤 주소가 #/note/<id>로 바뀌어도 id가 같아 화면이 다시 만들어지지 않는다.
  const freshId = useMemo(() => newId(), [route]) // eslint-disable-line react-hooks/exhaustive-deps
  const noteScreenId = route.name === 'new' ? freshId : route.name === 'note' ? route.id : null

  // 화면이 바뀌면 제목으로 초점을 옮긴다(키보드·스크린리더).
  const firstRender = useRef(true)
  useEffect(() => {
    // 처음 열 때는 초점을 옮기지 않는다(첫 Tab이 "본문으로 건너뛰기" 링크에 가도록).
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    markNavigated()
    focusHeading()
    window.scrollTo(0, 0)
  }, [noteScreenId ?? route.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickFilter = (f: Filter) => {
    setView({ filter: f })
    go(href.home())
  }
  const screen = route.name

  return (
    <div className="app" data-route={screen}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus() }}>
        본문으로 건너뛰기
      </a>
      <aside className="sidebar" aria-label="메뉴">
        <a className="brand" href={href.home()} aria-label="생각바로 홈">
          <img src="/assets/thinkbaro-icon.png" alt="" width="43" height="49" />
          <span>
            생각바로
            <small>떠오른 생각, 바로 글로.</small>
          </span>
        </a>
        <a className="btn primary new-btn" href={href.new('memo')}>
          <Icon name="plus" size={18} />새로운 생각 기록
        </a>
        <nav className="side-nav" aria-label="글 종류">
          {(['all', ...NOTE_TYPES, 'star'] as Filter[]).map((f) => (
            <button key={f} type="button" className={screen === 'home' && view.filter === f ? 'nav-item active' : 'nav-item'} aria-current={screen === 'home' && view.filter === f ? 'page' : undefined} onClick={() => pickFilter(f)}>
              <Icon name={f === 'all' ? 'grid' : f === 'star' ? 'star' : f === 'memo' ? 'note' : f === 'idea' ? 'bulb' : 'story'} size={18} />
              {f === 'all' || f === 'star' ? FILTER_LABEL[f] : TYPE_META[f].name}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <a className={screen === 'settings' ? 'nav-item active' : 'nav-item'} href={href.settings()} aria-current={screen === 'settings' ? 'page' : undefined}>
            <Icon name="settings" size={18} />
            설정·백업
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <a className="brand" href={href.home()} aria-label="생각바로 홈">
            <img src="/assets/thinkbaro-icon.png" alt="" width="34" height="38" />
            <span>생각바로</span>
          </a>
          <a className="btn ghost topbar-settings" href={href.settings()}>
            <Icon name="settings" size={18} />설정
          </a>
        </header>
        <main id="main" ref={main} tabIndex={-1}>
          {route.name === 'home' && <Home view={view} setView={setView} />}
          {noteScreenId && <NoteScreen key={noteScreenId} noteId={noteScreenId} newType={route.name === 'new' ? route.type : undefined} />}
          {route.name === 'record' && <RecordScreen key={`${route.type}-${route.noteId ?? 'new'}`} type={route.type} noteId={route.noteId} />}
          {route.name === 'settings' && <Settings />}
        </main>
        <a className="fab" href={href.new('memo')} aria-label="새로운 생각 기록">
          <Icon name="plus" size={26} />
        </a>
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'error' ? '⚠ ' : '✓ '}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
