import type { ComponentType } from 'react'
import {
  AccountsIcon,
  BarsIcon,
  CalendarIcon,
  DashboardIcon,
  LibraryIcon,
  PersonIcon,
  SendIcon,
  SettingsIcon,
  SparklesIcon,
} from './icons'

export interface AdminNavItem {
  label: string
  path: string
  icon: ComponentType
  /** Modules not built yet; their route shows a Coming Soon placeholder. */
  comingSoon?: boolean
  description?: string
}

export const ADMIN_NAV: AdminNavItem[] = [
  { label: 'Dashboard', path: '/admin/dashboard', icon: DashboardIcon },
  {
    label: 'X Accounts',
    path: '/admin/x-accounts',
    icon: AccountsIcon,
    description: 'Manage X accounts, their Content DNA and Omkar assignments.',
  },
  { label: 'Omkars', path: '/admin/omkars', icon: PersonIcon },
  {
    label: 'AI Content Studio',
    path: '/admin/content-studio',
    icon: SparklesIcon,
    description: 'Generate, write and refine drafts for each account and post slot.',
  },
  {
    label: 'Content Library',
    path: '/admin/library',
    icon: LibraryIcon,
    description: 'Review, edit and approve drafts with full history.',
  },
  {
    label: 'Calendar',
    path: '/admin/calendar',
    icon: CalendarIcon,
    comingSoon: true,
    description: 'See scheduled assignments and per-account content coverage.',
  },
  {
    label: 'Distribution',
    path: '/admin/distribution',
    icon: SendIcon,
    description: 'Send approved posts to Omkars on WhatsApp and track what was sent.',
  },
  {
    label: 'Analytics',
    path: '/admin/analytics',
    icon: BarsIcon,
    comingSoon: true,
    description: 'Network performance insights, planned for a later phase.',
  },
  {
    label: 'Settings',
    path: '/admin/settings',
    icon: SettingsIcon,
    comingSoon: true,
    description: 'Platform and administrator settings.',
  },
]
