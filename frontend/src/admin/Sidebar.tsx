import { NavLink } from 'react-router'
import { ADMIN_NAV } from './navigation'

interface SidebarProps {
  onNavigate?: () => void
  /** `rail`: narrow icon rail on desktop. `drawer`: full-width list in the mobile menu. */
  variant?: 'rail' | 'drawer'
}

/** Brand + navigation. Rendered as a fixed rail on desktop and inside the mobile drawer. */
export function Sidebar({ onNavigate, variant = 'drawer' }: SidebarProps) {
  const rail = variant === 'rail'
  return (
    <div className="flex h-full flex-col bg-navy-900 text-[#aeb6c2]">
      <div className={rail ? 'flex shrink-0 justify-center pt-5 pb-4' : 'flex shrink-0 items-center gap-3 px-5 py-5'}>
        <p className="font-display text-2xl leading-none text-ivory">
          OM<sup className="text-xs text-brass-light">2</sup>
        </p>
        {!rail && <p className="truncate text-xs text-[#aeb6c2]">Operation Million Mark</p>}
      </div>

      <nav aria-label="Admin" className={`min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-none ${rail ? 'px-2 pb-3' : 'px-3 py-2'}`}>
        <ul className={rail ? 'space-y-0.5' : 'space-y-1'}>
          {ADMIN_NAV.map(({ label, path, icon: Icon }) => (
            <li key={path}>
              <NavLink
                to={path}
                end
                onClick={onNavigate}
                title={rail ? label : undefined}
                className={({ isActive }) =>
                  `${
                    rail
                      ? 'flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-center text-[10.5px] leading-[1.25] font-medium'
                      : 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium'
                  } transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass ${
                    isActive ? 'bg-brass/20 text-brass-light' : 'hover:bg-ivory/[0.06] hover:text-ivory'
                  }`
                }
              >
                <Icon />
                <span className={rail ? 'w-full' : 'min-w-0 flex-1 truncate whitespace-nowrap'}>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <p className={`shrink-0 border-t border-navy-800 text-xs text-[#8d96a3] ${rail ? 'py-3 text-center text-[10.5px]' : 'px-5 py-4'}`}>
        {rail ? 'IST' : 'Times shown in IST'}
      </p>
    </div>
  )
}
