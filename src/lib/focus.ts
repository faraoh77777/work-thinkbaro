// 앱 안에서 화면을 옮긴 적이 있는지 기억한다. 처음 열 때는 초점을 옮기지 않아(첫 Tab = 본문으로 건너뛰기) 화면 전환 때만 제목으로 초점을 보낸다.
let navigated = false
export const markNavigated = (): void => {
  navigated = true
}
export const hasNavigated = (): boolean => navigated
export function focusHeading(): void {
  document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true })
}
