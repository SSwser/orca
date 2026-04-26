import { useEffect, useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { DashboardWorktreeCard } from './useDashboardData'
import type { DashboardFilter } from './useDashboardFilter'

type UseDashboardKeyboardParams = {
  filteredWorktrees: DashboardWorktreeCard[]
  focusedWorktreeId: string | null
  setFocusedWorktreeId: (id: string | null) => void
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
}

// Why: the listener must be scoped to the dashboard container so keystrokes
// (Arrow keys, digits 1-4, Enter, Escape) only fire when focus is inside the
// dashboard. Attaching to window intercepts terminal/xterm navigation (arrow
// keys for command history) and shell digit entry while the dashboard pane
// is merely open, which breaks those unrelated inputs.
//
// Why return a callback ref (and not accept a RefObject): AgentDashboard has
// an early-return branch that renders an empty state WITHOUT the container
// div when there are no repos. On initial render with no repos, a plain
// `useRef` would be null, our attach-effect would no-op, and then when repos
// later appear and the container mounts, React would NOT re-run the effect
// (a RefObject has stable identity, so its mutation doesn't trigger effects).
// The result: the keyboard listener would silently never attach on that path.
// A callback ref fires synchronously on attach/detach; storing the element in
// useState makes the effect re-run whenever the container appears or goes
// away, fixing the gap without any `ref.current`-as-dep anti-patterns.
type ContainerCallbackRef = (el: HTMLDivElement | null) => void

const FILTER_KEYS: Record<string, DashboardFilter> = {
  '1': 'all',
  '2': 'active',
  '3': 'blocked',
  '4': 'done'
}

export function useDashboardKeyboard({
  filteredWorktrees,
  focusedWorktreeId,
  setFocusedWorktreeId,
  filter,
  setFilter
}: UseDashboardKeyboardParams): ContainerCallbackRef {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)

  // Why: track the container element in state so the attach-effect re-runs
  // whenever the element mounts or unmounts. See the file-level comment for
  // why a plain RefObject is insufficient here.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)

  // Why: stash data the handler reads in refs so it doesn't re-bind on every
  // agent-status update (which produces a fresh filteredWorktrees array most
  // renders). Without this, the listener is add/removed at PTY event rate.
  const filteredWorktreesRef = useRef(filteredWorktrees)
  const focusedWorktreeIdRef = useRef(focusedWorktreeId)
  const filterRef = useRef(filter)
  const containerElRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    filteredWorktreesRef.current = filteredWorktrees
  })
  useEffect(() => {
    focusedWorktreeIdRef.current = focusedWorktreeId
  })
  useEffect(() => {
    filterRef.current = filter
  })
  useEffect(() => {
    // Why: mirror the element into a ref so the (stable) handleKeyDown
    // callback can query inside the current container without needing to
    // re-bind when the element identity changes.
    containerElRef.current = containerEl
  }, [containerEl])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Why: the dashboard now docks at the sidebar bottom regardless of
      // active tab, so gate only on whether the sidebar is visible. The
      // listener is already scoped to the dashboard container's element,
      // so focus-based scoping still isolates these shortcuts.
      if (!rightSidebarOpen) {
        return
      }

      // Don't intercept when focus is in an editable element
      const target = e.target as HTMLElement
      if (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) {
        return
      }

      // Don't intercept when a modifier key is held (let app shortcuts through)
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return
      }

      // Filter quick-select: 1-4 keys
      if (FILTER_KEYS[e.key]) {
        e.preventDefault()
        setFilter(FILTER_KEYS[e.key])
        return
      }

      // Escape: reset filter to 'all' (the default)
      if (e.key === 'Escape') {
        if (filterRef.current !== 'all') {
          e.preventDefault()
          setFilter('all')
        }
        return
      }

      // Arrow key navigation
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const worktrees = filteredWorktreesRef.current
        const ids = worktrees.map((wt) => wt.worktree.id)
        if (ids.length === 0) {
          return
        }

        const focused = focusedWorktreeIdRef.current
        const currentIndex = focused ? ids.indexOf(focused) : -1

        let nextIndex: number
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          nextIndex = currentIndex < ids.length - 1 ? currentIndex + 1 : 0
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : ids.length - 1
        }

        const nextId = ids[nextIndex]
        setFocusedWorktreeId(nextId)

        // Focus the corresponding DOM card. Why: scope the lookup to the
        // dashboard container so we don't accidentally match a card rendered
        // elsewhere in the app (and so the query fails closed when the
        // container is unmounted).
        // Why: worktreeId is `${repoId}::${path}` (see src/shared/types.ts)
        // and filesystem paths can contain characters like `"` or `\` that
        // would otherwise break the attribute-selector string and throw a
        // SyntaxError, silently killing arrow-key navigation. CSS.escape()
        // safely encodes those special characters.
        const cardEl = containerElRef.current?.querySelector(
          `[data-worktree-id="${CSS.escape(nextId)}"]`
        ) as HTMLElement | null
        cardEl?.focus()
        return
      }

      // Enter: navigate to focused worktree.
      // Why: only fire when the native keydown target IS a worktree card
      // (has data-worktree-id). Otherwise Enter on an interactive descendant
      // (dismiss X, expand chevron, clear-search button, filter toggle) would
      // be preventDefault'd by this handler — blocking the button's own
      // activation AND triggering unwanted navigation. The card element
      // itself is role="button" with tabIndex=0, so it receives focus during
      // arrow navigation, and Enter on it should navigate as intended.
      if (e.key === 'Enter' && focusedWorktreeIdRef.current) {
        const enterTarget = e.target as HTMLElement | null
        if (!enterTarget || !enterTarget.dataset.worktreeId) {
          return
        }
        e.preventDefault()
        setActiveWorktree(focusedWorktreeIdRef.current)
        setActiveView('terminal')
      }
    },
    [rightSidebarOpen, setFocusedWorktreeId, setFilter, setActiveWorktree, setActiveView]
  )

  useEffect(() => {
    // Why: attach to the dashboard container rather than window so these
    // shortcuts only fire when focus is inside the dashboard. This prevents
    // Arrow keys and digits 1-4 from hijacking the terminal (xterm history
    // navigation) and shell input while the dashboard pane is open.
    //
    // Why depend on `containerEl` (state) not a ref: the container is not
    // rendered on the empty-state branch, so it mounts *after* this hook
    // first runs once repos appear. State-backed tracking via the callback
    // ref guarantees this effect re-runs at that mount.
    if (!containerEl) {
      return
    }
    containerEl.addEventListener('keydown', handleKeyDown)
    return () => containerEl.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown, containerEl])

  // Why: return a stable callback ref so the caller can spread it onto the
  // container's `ref` prop. useState's setter identity is stable across
  // renders, so this doesn't churn React's ref-assignment cycle.
  return setContainerEl
}
