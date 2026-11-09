import { createRoot } from 'react-dom/client';
import { AuthKitProvider } from '@workos-inc/authkit-react';
import { AuthenticatedBoundary } from './components/AuthenticatedBoundary.tsx';
import { LoginRedirect } from './components/LoginRedirect.tsx';
import './index.css';

const isLoginRoute = window.location.pathname === '/login';

createRoot(document.getElementById('root')!).render(
  <AuthKitProvider
    clientId={import.meta.env.VITE_WORKOS_CLIENT_ID}
    redirectUri={import.meta.env.VITE_WORKOS_REDIRECT_URI}
    onRedirectCallback={() => window.history.replaceState({}, '', '/')}
  >
    {isLoginRoute ? <LoginRedirect /> : <AuthenticatedBoundary />}
  </AuthKitProvider>,
);
