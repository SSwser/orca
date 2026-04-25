import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import AgentDashboard from '../dashboard/AgentDashboard'

const MIN_HEIGHT = 140
const DEFAULT_HEIGHT = 300
const HEADER_HEIGHT = 28
const STORAGE_KEY = 'orca.dashboardSidebarPanel'

type PersistedState = {
  height: number
  collapsed: boolean
}

function loadPersistedState(): PersistedState {
  if (typeof window === 'undefined') {
    return { height: DEFAULT_HEIGHT, collapsed: false }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { height: DEFAULT_HEIGHT, collapsed: false }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_HEIGHT,
      collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : false
    }
  } catch {
    return { height: DEFAULT_HEIGHT, collapsed: false }
  }
}

// Why: a persistent bottom section of the right sidebar that always shows the
// agent dashboard, independent of which activity tab the user has open. The
// user drags the top edge to resize upward and can fully collapse to a
// single header row.
export default function DashboardBottomPanel(): React.JSX.Element {
  const initial = useMemo(loadPersistedState, [])
  const [height, setHeight] = useState<number>(initial.height)
  const [collapsed, setCollapsed] = useState<boolean>(initial.collapsed)

  const containerRef = useRef<HTMLDivElement>(null)
  const resizeStateRef = useRef<{
    startY: number
    startHeight: number
    maxHeight: number
  } | null>(null)

  // Why: persist height + collapsed via localStorage (renderer-only) so the
  // layout survives reloads. Debounce writes so continuous drag doesn't spam.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ height, collapsed }))
      } catch {
        // ignore quota / privacy-mode errors
      }
    }, 150)
    return () => window.clearTimeout(timer)
  }, [height, collapsed])

  const onResizeMove = useCallback((event: MouseEvent) => {
    const state = resizeStateRef.current
    if (!state) {
      return
    }
    const deltaY = state.startY - event.clientY
    const next = Math.max(MIN_HEIGHT, Math.min(state.maxHeight, state.startHeight + deltaY))
    setHeight(next)
  }, [])

  const onResizeEnd = useCallback(() => {
    resizeStateRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', onResizeEnd)
  }, [onResizeMove])

  const onResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      // Why: no `collapsed` guard here — the resize handle is only rendered
      // when `!collapsed` (see below), so this callback is unreachable while
      // collapsed. Keeping a `setCollapsed(false)` branch would be dead code
      // and would mislead future readers into thinking the handle can fire
      // in the collapsed state.
      // Why: cap expansion so the dashboard can't push the active panel
      // content to a zero-height strip. Leave 160px for the panel above.
      const sidebarEl = containerRef.current?.parentElement
      const sidebarHeight = sidebarEl?.getBoundingClientRect().height ?? 800
      const maxHeight = Math.max(MIN_HEIGHT, sidebarHeight - 160)
      resizeStateRef.current = {
        startY: event.clientY,
        startHeight: height,
        maxHeight
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onResizeMove)
      window.addEventListener('mouseup', onResizeEnd)
    },
    [height, onResizeMove, onResizeEnd]
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onResizeMove)
      window.removeEventListener('mouseup', onResizeEnd)
      // Why: if the component unmounts mid-drag (e.g. user hides the
      // dashboard from settings while dragging, or a hot-reload swaps the
      // tree), onResizeEnd never fires. Without this restore, document.body
      // would stay stuck on `row-resize` with text selection disabled
      // app-wide until the next full reload.
      if (resizeStateRef.current !== null) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [onResizeMove, onResizeEnd])

  const effectiveHeight = collapsed ? HEADER_HEIGHT : height

  return (
    <div
      ref={containerRef}
      className="relative flex shrink-0 flex-col border-t border-border bg-sidebar"
      style={{ height: effectiveHeight }}
    >
      {/* Resize handle — hidden while collapsed so the user must expand first. */}
      {!collapsed && (
        <div
          className="absolute left-0 right-0 z-10 -mt-[3px] h-[6px] cursor-row-resize transition-colors hover:bg-ring/20 active:bg-ring/30"
          onMouseDown={onResizeStart}
          aria-label="Resize dashboard panel"
        />
      )}

      {/* Header: title + collapse toggle (click anywhere to toggle).
          Why: the entire header is a single <button> rather than a <div>
          wrapping a nested <button>. Nesting interactive elements is invalid
          HTML and breaks screen readers — previously the inner button had no
          onClick of its own and relied on click bubbling to the div, so
          assistive tech announced a button that appeared to do nothing. */}
      <button
        type="button"
        className="flex w-full shrink-0 select-none items-center gap-1 px-2 text-left"
        style={{ height: HEADER_HEIGHT }}
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand dashboard' : 'Collapse dashboard'}
      >
        <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agents
        </span>
      </button>

      {/* Body: full AgentDashboard */}
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <AgentDashboard />
        </div>
      )}
    </div>
  )
}
