const P: Record<string, string> = {
  grid: 'M5 3h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm11 0h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM5 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Zm11 0h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z',
  note: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  bulb: 'M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z',
  story: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-2 5 18-1M7 4l3 4M14 4l3 4m-7 5 5 3-5 3z',
  mic: 'M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM16 16l5 5',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'M19 12H5m5-5-5 5 5 5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-3-6-.6 2.4-2 .9L4 5.7 2 9l1.8 1.7v2.6L2 15l2 3.3 2.4-.6 2 .9L9 21h6l.6-2.4 2-.9 2.4.6 2-3.3-1.8-1.7v-2.6L22 9l-2-3.3-2.4.6-2-.9L15 3Z',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  pen: 'm15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  headphones: 'M3 14v-3a9 9 0 0 1 18 0v3M5 12h-1a1 1 0 0 0-1 1v5a2 2 0 0 0 2 2h1v-8Zm14 0h1a1 1 0 0 1 1 1v5a2 2 0 0 1-2 2h-1v-8Z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  play: 'M7 4v16l13-8z',
  download: 'M12 3v12m-5-5 5 5 5-5M4 21h16',
  upload: 'M12 15V3m-5 5 5-5 5 5M4 21h16',
  list: 'M4 6h16M4 12h16M4 18h16',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  warn: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
}

export function Icon({ name, size = 20 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24">
      <path d={P[name] ?? ''} />
    </svg>
  )
}
