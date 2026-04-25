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
      if (collapsed) {
        setCollapsed(false)
      }
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
    [collapsed, height, onResizeMove, onResizeEnd]
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onResizeMove)
      window.removeEventListener('mouseup', onResizeEnd)
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

      {/* Header: title + collapse toggle (click anywhere to toggle) */}
      <div
        className="flex shrink-0 cursor-pointer select-none items-center gap-1 px-2"
        style={{ height: HEADER_HEIGHT }}
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={collapsed ? 'Expand dashboard' : 'Collapse dashboard'}
        >
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agents
        </span>
      </div>

      {/* Body: full AgentDashboard */}
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <AgentDashboard />
        </div>
      )}
    </div>
  )
}
