import { Navigate, Route, Routes } from 'react-router'
import { AdminLayout } from './admin/AdminLayout'
import { ContentDnaEditorPage } from './admin/content-dna/ContentDnaEditorPage'
import { ContentLibraryPage } from './admin/content-library/ContentLibraryPage'
import { ContentStudioPage } from './admin/content-studio/ContentStudioPage'
import { DistributionPage } from './admin/distribution/DistributionPage'
import { MillionaireDashboard } from './admin/MillionaireDashboard'
import { ModulePlaceholder } from './admin/ModulePlaceholder'
import { ADMIN_NAV } from './admin/navigation'
import { OmkarsPage } from './admin/omkars/OmkarsPage'
import { XAccountsPage } from './admin/x-accounts/XAccountsPage'
import { useAuth } from './auth/AuthContext'
import { DASHBOARD_PATHS } from './auth/roles'
import { ComingSoon } from './components/ComingSoon'
import { LoginPage } from './components/LoginPage'
import { SessionLoading } from './components/SessionLoading'
import { ProtectedRoute } from './routes/ProtectedRoute'
import { PublicOnlyRoute } from './routes/PublicOnlyRoute'

function RootRedirect() {
  const { auth } = useAuth()
  if (auth.status === 'checking') return <SessionLoading />
  if (auth.status === 'anonymous') return <Navigate to="/login" replace />
  return <Navigate to={DASHBOARD_PATHS[auth.user.role]} replace />
}

function LoginRoute() {
  const { auth, setUser } = useAuth()
  // Once setUser runs, PublicOnlyRoute redirects to the user's dashboard.
  return <LoginPage notice={auth.status === 'anonymous' ? auth.notice : null} onLogin={setUser} />
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginRoute />} />
      </Route>
      <Route element={<ProtectedRoute allowedRoles={['MILLIONAIRE']} />}>
        <Route element={<AdminLayout />}>
          <Route path="/admin/dashboard" element={<MillionaireDashboard />} />
          <Route path="/admin/x-accounts" element={<XAccountsPage />} />
          <Route path="/admin/x-accounts/:id/content-dna" element={<ContentDnaEditorPage />} />
          <Route path="/admin/omkars" element={<OmkarsPage />} />
          <Route path="/admin/content-studio" element={<ContentStudioPage />} />
          <Route path="/admin/library" element={<ContentLibraryPage />} />
          <Route path="/admin/distribution" element={<DistributionPage />} />
          {ADMIN_NAV.filter((item) => item.comingSoon).map((item) => (
            <Route key={item.path} path={item.path} element={<ModulePlaceholder item={item} />} />
          ))}
        </Route>
      </Route>
      <Route element={<ProtectedRoute allowedRoles={['OMKAR']} />}>
        <Route path="/omkar/dashboard" element={<ComingSoon title="Omkar Dashboard — Coming Soon" />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
