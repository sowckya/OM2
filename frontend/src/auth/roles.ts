import type { Role } from '../api/auth'

export const DASHBOARD_PATHS: Record<Role, string> = {
  MILLIONAIRE: '/admin/dashboard',
  OMKAR: '/omkar/dashboard',
}
