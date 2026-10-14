// The in-app menu bar, the same in the desktop app and the web build: File, Edit, View, Window (one entry per open tab,
// the current one ticked) and Help. Every item is a command from the registry (commands.ts), shown with its shortcut.
// The keyboard works as in a desktop app's menu bar (WAI-ARIA's menubar pattern): Alt or F10 moves to the bar, the
// arrow keys move along it and down a menu, Enter or Space runs an item, Home and End go to the ends, Esc goes back.
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { formatKey, keysOf, runCommand, type Command } from '../commands'
import { DOCS } from '../help/docs'
import type { Platform } from '../platform'
import { isUnsaved, tabTitle, useStore } from '../store'
import { CheckIcon } from './Icons'

type Item = { kind: 'command'; id: string } | { kind: 'separator' } | { kind: 'tab'; id: string; index: number }

interface Menu {
  label: string
  items: Item[]
}

const command = (id: string): Item => ({ kind: 'command', id })
const SEPARATOR: Item = { kind: 'separator' }
const docLabel = (page: string): string => DOCS.find((d) => d.id === page)?.label ?? page

export function MenuBar({ commands, platform }: { commands: readonly Command[]; platform: Platform }) {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeId)
  // Read so the theme's ticks and the enabled items redraw when they change.
  useStore((s) => s.theme)
  const [open, setOpen] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Where the focus was before it came to the bar, to give it back. */
  const returnFocus = useRef<HTMLElement | null>(null)
  const byId = new Map(commands.map((c) => [c.id, c]))

  const menus: Menu[] = [
    { label: 'File', items: ['tab.new', 'file.open', '-', 'file.save', 'file.saveAs', '-', 'tab.close', ...(byId.has('app.exit') ? ['-', 'app.exit'] : [])].map((id) => (id === '-' ? SEPARATOR : command(id))) },
    { label: 'Edit', items: [command('edit.undo'), command('edit.redo'), SEPARATOR, command('edit.copyOutput'), command('edit.paste')] },
    { label: 'View', items: [command('view.theme.system'), command('view.theme.light'), command('view.theme.dark')] },
    { label: 'Window', items: [...tabs.map((t, index): Item => ({ kind: 'tab', id: t.id, index })), ...(tabs.length ? [SEPARATOR] : []), command('window.next'), command('window.previous')] },
    { label: 'Help', items: [command('help.guide'), command('help.changelog'), command('help.license'), command('help.notices'), SEPARATOR, command('help.about')] }
  ]

  const barButtons = (): HTMLButtonElement[] => [...(barRef.current?.querySelectorAll<HTMLButtonElement>('[data-menubar-item]') ?? [])]
  const menuItems = (): HTMLButtonElement[] => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not([aria-disabled=true])') ?? [])]

  /** Leaves the bar: the menu closes and the focus goes back where it was. */
  const leave = (): void => {
    setOpen(null)
    const back = returnFocus.current
    returnFocus.current = null
    if (back?.isConnected) back.focus()
    // Nowhere to go back to (the focus was on the page itself): it leaves the bar all the same.
    if (barRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }

  /** Opens menu `i`, its first item focused when asked (the keyboard), else its button. */
  const openMenu = (i: number, focusItem: 'first' | 'last' | null): void => {
    setOpen(i)
    barButtons()[i]?.focus()
    if (focusItem) requestAnimationFrame(() => (focusItem === 'first' ? menuItems()[0] : menuItems().at(-1))?.focus())
  }

  // Alt alone (pressed and let go with no other key between) or F10 moves to the bar, and back again.
  useEffect(() => {
    let altAlone = false
    const toggle = (): void => {
      if (barRef.current?.contains(document.activeElement) || menuRef.current?.contains(document.activeElement)) return leave()
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      barButtons()[0]?.focus()
    }
    const onDown = (e: KeyboardEvent): void => {
      altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey
      if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        toggle()
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Alt' || !altAlone) return
      altAlone = false
      e.preventDefault()
      toggle()
    }
    const onMouse = (e: MouseEvent): void => {
      altAlone = false
      if (open !== null && !barRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onBlur = (): void => setOpen(null)
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('mousedown', onMouse, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('mousedown', onMouse, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const onBarFocus = (e: FocusEvent): void => {
    const from = e.relatedTarget as HTMLElement | null
    if (from && !barRef.current?.contains(from) && !menuRef.current?.contains(from)) returnFocus.current = from
  }

  const onBarKey = (i: number) => (e: ReactKeyboardEvent): void => {
    const n = menus.length
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
      if (open !== null) openMenu(next, 'first')
      else barButtons()[next]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      barButtons()[e.key === 'Home' ? 0 : n - 1]?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu(i, 'first')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu(i, 'last')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (open !== null) setOpen(null)
      else leave()
    } else if (e.key === 'Tab') {
      setOpen(null)
    }
  }

  const onMenuKey = (e: ReactKeyboardEvent): void => {
    const items = menuItems()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (to: number): void => {
      e.preventDefault()
      items[(to + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && open !== null) {
      e.preventDefault()
      openMenu((open + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length, 'first')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const i = open
      setOpen(null)
      if (i !== null) barButtons()[i]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      leave()
    }
  }

  /** Runs an item: the menu closes and the focus goes back first, so the command acts where the user was. */
  const choose = (run: () => void) => (): void => {
    leave()
    run()
  }

  const renderItem = (item: Item, key: number) => {
    if (item.kind === 'separator') return <div key={key} className="menu-sep" role="separator" />
    if (item.kind === 'tab') {
      const tab = tabs.find((t) => t.id === item.id)!
      const current = tab.id === activeId
      const title = tabTitle(tab, docLabel)
      return (
        <button key={key} role="menuitemradio" aria-checked={current} className="menu-item" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={choose(() => useStore.getState().activate(tab.id))}>
          <span className="menu-check">{current && <CheckIcon />}</span>
          <span className="menu-label">
            {title}
            {isUnsaved(tab) ? ' •' : ''}
          </span>
          <span className="menu-key">{item.index < 9 ? formatKey(platform.kind === 'web' ? `Alt+${item.index + 1}` : `Mod+${item.index + 1}`) : ''}</span>
        </button>
      )
    }
    const c = byId.get(item.id)
    if (!c) return null
    const disabled = c.enabled ? !c.enabled() : false
    const checked = c.checked?.()
    const keys = keysOf(c, platform.kind)
    return (
      <button
        key={key}
        role={checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        className="menu-item"
        tabIndex={-1}
        title={c.tip}
        onMouseDown={(e) => e.preventDefault()}
        onClick={disabled ? undefined : choose(() => runCommand(c))}
      >
        <span className="menu-check">{checked && <CheckIcon />}</span>
        <span className="menu-label">{c.label}</span>
        <span className="menu-key">{keys[0] ? formatKey(keys[0]) : ''}</span>
      </button>
    )
  }

  return (
    <div className="menubar" role="menubar" aria-label="Menu" ref={barRef} onFocus={onBarFocus}>
      {menus.map((m, i) => (
        <div key={m.label} className="menubar-entry">
          <button
            data-menubar-item
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            className={`menubar-item${open === i ? ' open' : ''}`}
            tabIndex={i === 0 ? 0 : -1}
            onKeyDown={onBarKey(i)}
            onClick={() => (open === i ? setOpen(null) : openMenu(i, null))}
            onMouseEnter={() => open !== null && open !== i && openMenu(i, null)}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="menu" role="menu" aria-label={m.label} ref={menuRef} onKeyDown={onMenuKey}>
              {m.items.map(renderItem)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
