import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { SessionProvider } from './SessionContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Inbox from './pages/Inbox';
import SessionsPage from './pages/Sessions';
import RulesPage from './pages/Rules';
import TemplateList from './pages/TemplateList';
import TemplateNew from './pages/TemplateNew';
import TemplateDetail from './pages/TemplateDetail';
import Bulk from './pages/Bulk';
import ScheduledPage from './pages/Scheduled';
import SchedulesPage from './pages/Schedules';
import BotsPage from './pages/Bots';
import BotBuilder from './pages/BotBuilder';
import WebhooksPage from './pages/Webhooks';
import './App.css';

function Protected({ children }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="boot">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <SessionProvider>{children}</SessionProvider>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route
            element={
              <Protected>
                <Layout />
              </Protected>
            }
          >
            <Route path="/" element={<Inbox />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/templates" element={<TemplateList />} />
            <Route path="/templates/new" element={<TemplateNew />} />
            <Route path="/templates/:id" element={<TemplateDetail />} />
            <Route path="/bulk" element={<Bulk />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/scheduled" element={<ScheduledPage />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/bots/:id" element={<BotBuilder />} />
            <Route path="/webhooks" element={<WebhooksPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
