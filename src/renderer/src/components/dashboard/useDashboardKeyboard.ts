import { useEffect, useCallback } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import type { DashboardWorktreeCard } from './useDashboardData'
import type { DashboardFilter } from './useDashboardFilter'

type UseDashboardKeyboardParams = {
  filteredWorktrees: DashboardWorktreeCard[]
  focusedWorktreeId: string | null
  setFocusedWorktreeId: (id: string | null) => void
  filter: DashboardFilter
  setFilter: (f: DashboardFilter) => void
  // Why: the listener must be scoped to the dashboard container so keystrokes
  // (Arrow keys, digits 1-4, Enter, Escape) only fire when focus is inside the
  // dashboard. Attaching to window intercepts terminal/xterm navigation (arrow
  // keys for command history) and shell digit entry while the dashboard pane
  // is merely open, which breaks those unrelated inputs.
  containerRef: React.RefObject<HTMLElement | null>
}

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
  setFilter,
  containerRef
}: UseDashboardKeyboardParams): void {
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)

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
        if (filter !== 'all') {
          e.preventDefault()
          setFilter('all')
        }
        return
      }

      // Arrow key navigation
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const ids = filteredWorktrees.map((wt) => wt.worktree.id)
        if (ids.length === 0) {
          return
        }

        const currentIndex = focusedWorktreeId ? ids.indexOf(focusedWorktreeId) : -1

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
        const cardEl = containerRef.current?.querySelector(
          `[data-worktree-id="${nextId}"]`
        ) as HTMLElement | null
        cardEl?.focus()
        return
      }

      // Enter: navigate to focused worktree
      if (e.key === 'Enter' && focusedWorktreeId) {
        e.preventDefault()
        setActiveWorktree(focusedWorktreeId)
        setActiveView('terminal')
      }
    },
    [
      rightSidebarOpen,
      filteredWorktrees,
      focusedWorktreeId,
      setFocusedWorktreeId,
      filter,
      setFilter,
      setActiveWorktree,
      setActiveView,
      containerRef
    ]
  )

  useEffect(() => {
    // Why: attach to the dashboard container rather than window so these
    // shortcuts only fire when focus is inside the dashboard. This prevents
    // Arrow keys and digits 1-4 from hijacking the terminal (xterm history
    // navigation) and shell input while the dashboard pane is open.
    const el = containerRef.current
    if (!el) {
      return
    }
    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown, containerRef])
}
