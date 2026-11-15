/** D15C-5P — separate preview-only React entry, never imported by src/main.tsx. */
import { createRoot } from 'react-dom/client';
import { AuthKitProvider } from '@workos-inc/authkit-react';
import { LocalHistoryPreview } from '../components/LocalHistoryPreview.js';
import '../index.css';

// WorkOS must have this exact localhost callback on its allowed redirect list.
// No bearer tokens or customer identifiers appear in the callback URL.
const callback = `${window.location.origin}/history-preview`;
const clientId: string | undefined = import.meta.env.VITE_WORKOS_CLIENT_ID;
const element = document.getElementById('root');
if (!element) throw new Error('Missing preview root element');
const root = createRoot(element);

if (!clientId || !clientId.startsWith('client_')) {
  root.render(
    <main className="min-h-screen bg-neutral-950 p-8 text-amber-200">
      WorkOS client ID is not configured for the local preview. Monitoring remains disabled.
    </main>,
  );
} else {
  root.render(
    <AuthKitProvider clientId={clientId} redirectUri={callback}
      onRedirectCallback={() => window.history.replaceState({}, '', '/history-preview')}>
      <LocalHistoryPreview />
    </AuthKitProvider>,
  );
}
