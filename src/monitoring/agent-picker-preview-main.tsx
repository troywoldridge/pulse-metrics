/** D15C-5Q — independent local-development React entrypoint. */
import { createRoot } from 'react-dom/client';
import { AuthKitProvider } from '@workos-inc/authkit-react';
import { LocalAgentPickerPreview } from '../components/LocalAgentPickerPreview.js';
import '../index.css';

const callback = `${window.location.origin}/history-preview`;
const clientId: string | undefined = import.meta.env.VITE_WORKOS_CLIENT_ID;
const element = document.getElementById('root');
if (!element) throw new Error('Missing preview root');
const root = createRoot(element);
if (!clientId || !clientId.startsWith('client_')) {
  root.render(<main className="min-h-screen bg-neutral-950 p-8 text-amber-200">
    WorkOS client ID missing. Monitoring remains disabled.
  </main>);
} else {
  root.render(<AuthKitProvider clientId={clientId} redirectUri={callback}
    onRedirectCallback={() => window.history.replaceState({}, '', '/history-preview')}>
    <LocalAgentPickerPreview />
  </AuthKitProvider>);
}
