import { useEffect } from 'react';
import { useAuth } from '@workos-inc/authkit-react';

// Initiate login URI target: starts AuthKit sign-in as soon as the client is ready.
export function LoginRedirect() {
  const { isLoading, signIn } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      signIn();
    }
  }, [isLoading, signIn]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-400 flex items-center justify-center font-mono text-sm">
      Redirecting to sign in…
    </div>
  );
}
