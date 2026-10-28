import { useMemo, useState } from 'react'
import { fmtDateTime } from '../lib/format'
import { go, href } from '../lib/router'
import { useApp } from '../lib/store'
import { norm } from '../lib/text'
import type { Note, NoteType } from '../lib/types'
import { NOTE_TYPES, TYPE_META } from '../lib/types'
import { Icon } from './Icon'

export type Filter = 'all' | NoteType | 'star'
export type Sort = 'recent' | 'old' | 'title'
export interface ViewState {
  filter: Filter
  query: string
  sort: Sort
  layout: 'grid' | 'list'
}

export const FILTER_LABEL: Record<Filter, string> = { all: '모든 생각', memo: '단순메모', idea: '아이디어', story: '대본·스토리', star: '즐겨찾기' }
const PAGE = 30

const haystackCache = new Map<string, string>()
function haystack(n: Note): string {
  const key = `${n.id}:${n.revision}`
  let h = haystackCache.get(key)
  if (h === undefined) {
    h = norm([n.title, n.originalText, n.transcriptOriginal, n.sourceText, n.generatedContent, n.editedContent].join('\n'))
    haystackCache.set(key, h)
  }
  return h
}
/** 카드에 보여줄 본문: 사용자 수정본 > 상세 작성본 > 원문 */
export const bestText = (n: Note): string => n.editedContent || n.generatedContent || n.sourceText

export function filterNotes(notes: Note[], v: ViewState): Note[] {
  const q = norm(v.query.trim())
  const list = notes.filter((n) => (v.filter === 'all' || (v.filter === 'star' ? n.favorite : n.type === v.filter)) && (!q || haystack(n).includes(q)))
  const cmp: Record<Sort, (a: Note, b: Note) => number> = {
    recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    old: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    title: (a, b) => (a.title || '￿').localeCompare(b.title || '￿', 'ko'),
  }
  return list.sort(cmp[v.sort])
}

export function Home({ view, setView }: { view: ViewState; setView: (p: Partial<ViewState>) => void }) {
  const { notes, loaded, storageError, drafts } = useApp()
  const [recType, setRecType] = useState<NoteType>('memo')
  const [shown, setShown] = useState(PAGE)
  const list = useMemo(() => filterNotes(notes, view), [notes, view])
  const noteIds = useMemo(() => new Set(notes.map((n) => n.id)), [notes])
  const orphanDrafts = drafts.filter((d) => !noteIds.has(d.noteId) && (d.fields.sourceText || d.fields.title || d.fields.editedContent || d.fields.generatedContent))
  const counts = useMemo(() => ({ all: notes.length }), [notes])

  return (
    <div className="home">
      <section className="hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <p className="eyebrow">생각이 글이 되는 나만의 공간</p>
          <h1 id="hero-h" tabIndex={-1}>
            떠오른 생각,
            <br />
            <em>바로 글로.</em>
          </h1>
          <p className="lead">말하거나 쓰면, 제목과 자세한 글로 정리해 드려요. 이 브라우저에 저장됩니다.</p>
        </div>
        <div className="voice-card">
          <img src="/assets/thinkbaro-icon.png" alt="" width="56" height="64" />
          <div className="voice-body">
            <strong>생각이 떠올랐나요?</strong>
            <fieldset className="seg" aria-label="녹음할 글의 종류">
              {NOTE_TYPES.map((t) => (
                <label key={t} className={recType === t ? 'on' : ''}>
                  <input type="radio" name="rectype" value={t} checked={recType === t} onChange={() => setRecType(t)} />
                  {TYPE_META[t].name}
                </label>
              ))}
            </fieldset>
            <div className="voice-actions">
              <button type="button" className="btn primary big" onClick={() => go(href.record(recType))}>
                <Icon name="mic" />
                눌러서 말하기
              </button>
              <button type="button" className="btn ghost big" onClick={() => go(href.new(recType))}>
                <Icon name="pen" />
                글로 쓰기
              </button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="types-h" className="types">
        <h2 id="types-h">어떤 생각을 담아볼까요?</h2>
        <div className="type-grid">
          {NOTE_TYPES.map((t) => (
            <a key={t} className={`type-card ${t}`} href={href.new(t)}>
              <span className="type-icon">
                <Icon name={t === 'memo' ? 'note' : t === 'idea' ? 'bulb' : 'story'} />
              </span>
              <span className="type-copy">
                <strong>{TYPE_META[t].name}</strong>
                <span>{TYPE_META[t].short}</span>
              </span>
              <Icon name="arrow" size={18} />
            </a>
          ))}
        </div>
      </section>

      {orphanDrafts.length > 0 && (
        <section className="notice" aria-label="임시 저장된 글">
          <strong>작성 중이던 글이 {orphanDrafts.length}건 임시 저장되어 있어요.</strong>
          <ul className="draft-list">
            {orphanDrafts.map((d) => (
              <li key={d.noteId}>
                <a href={href.note(d.noteId)}>
                  {d.fields.title || '제목 없음'} · {TYPE_META[d.fields.type].name} · {fmtDateTime(d.savedAt)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="list-h" className="notes-section">
        <div className="notes-head">
          <h2 id="list-h">
            {FILTER_LABEL[view.filter]} <span className="count" aria-label={`${list.length}개`}>{list.length}</span>
          </h2>
          <div className="view-toggle" role="group" aria-label="보기 방식">
            <button type="button" className="icon-btn" aria-pressed={view.layout === 'grid'} aria-label="카드로 보기" onClick={() => setView({ layout: 'grid' })}>
              <Icon name="grid" />
            </button>
            <button type="button" className="icon-btn" aria-pressed={view.layout === 'list'} aria-label="목록으로 보기" onClick={() => setView({ layout: 'list' })}>
              <Icon name="list" />
            </button>
          </div>
        </div>
        <div className="toolbar">
          <div className="tabs" role="group" aria-label="글 종류 필터">
            {(['all', 'memo', 'idea', 'story', 'star'] as Filter[]).map((f) => (
              <button key={f} type="button" aria-pressed={view.filter === f} className={view.filter === f ? 'selected' : ''} onClick={() => setView({ filter: f })}>
                {f === 'all' ? '전체' : f === 'star' ? '★ 즐겨찾기' : TYPE_META[f].name}
              </button>
            ))}
          </div>
          <div className="search-sort">
            <label className="search">
              <Icon name="search" size={18} />
              <span className="sr-only">제목과 본문 검색</span>
              <input type="search" value={view.query} placeholder="제목·본문 검색" onChange={(e) => setView({ query: e.target.value })} />
            </label>
            <label className="sort">
              <span className="sr-only">정렬</span>
              <select value={view.sort} onChange={(e) => setView({ sort: e.target.value as Sort })}>
                <option value="recent">최근 수정순</option>
                <option value="old">오래된 순</option>
                <option value="title">제목순</option>
              </select>
            </label>
          </div>
        </div>

        {storageError && (
          <p className="notice error" role="alert">
            저장소를 열지 못했습니다: {storageError} 이 상태에서는 기록이 저장되지 않을 수 있어요.
          </p>
        )}
        {!loaded && <p className="muted">불러오는 중…</p>}
        {loaded && !storageError && counts.all === 0 && (
          <div className="empty" role="status">
            <Icon name="bulb" size={32} />
            <h3>새로운 생각을 담을 자리</h3>
            <p>첫 생각을 말하거나 글로 남겨 보세요.</p>
            <a className="btn primary" href={href.new('memo')}>
              생각 기록하기
            </a>
          </div>
        )}
        {loaded && counts.all > 0 && list.length === 0 && (
          <div className="empty" role="status">
            <Icon name="search" size={32} />
            <h3>{view.query ? '검색 결과가 없어요' : view.filter === 'star' ? '즐겨찾기한 글이 없어요' : '이 종류의 글이 아직 없어요'}</h3>
            <p>{view.query ? `"${view.query}"을(를) 포함한 글이 없습니다. 다른 검색어나 필터를 써 보세요.` : '다른 필터를 고르거나 새 글을 남겨 보세요.'}</p>
            {(view.query || view.filter !== 'all') && (
              <button type="button" className="btn ghost" onClick={() => setView({ query: '', filter: 'all' })}>
                필터·검색 지우기
              </button>
            )}
          </div>
        )}
        <div className={view.layout === 'grid' ? 'cards' : 'cards rows'}>
          {list.slice(0, shown).map((n) => (
            <NoteCard key={n.id} n={n} />
          ))}
        </div>
        {list.length > shown && (
          <button type="button" className="btn ghost more" onClick={() => setShown((s) => s + PAGE)}>
            더 보기 ({list.length - shown}개 남음)
          </button>
        )}
      </section>
    </div>
  )
}

function NoteCard({ n }: { n: Note }) {
  const text = bestText(n)
  const kind = n.editedContent ? '내 수정본' : n.generatedContent ? '상세 작성본' : '원문'
  return (
    <a className={`note-card ${n.type}`} href={href.note(n.id)} aria-label={`${n.title || '제목 없음'}, ${TYPE_META[n.type].name}${n.favorite ? ', 즐겨찾기' : ''}`}>
      <span className="card-top">
        <span className={`chip ${n.type}`}>{TYPE_META[n.type].name}</span>
        {n.favorite && (
          <span className="fav" title="즐겨찾기">
            ★<span className="sr-only">즐겨찾기</span>
          </span>
        )}
        {n.recordingId && <span className="chip plain">음성</span>}
      </span>
      <strong className="card-title">{n.title || '제목 없음'}</strong>
      {/* 줄임은 CSS(line-clamp)로만 표시한다. 저장된 본문은 그대로다. */}
      <span className="card-text">{text || '내용 없음'}</span>
      <span className="card-meta">
        {kind} · {fmtDateTime(n.updatedAt)}
      </span>
    </a>
  )
}
