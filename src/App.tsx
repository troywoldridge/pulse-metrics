/**
 * Pulse Metrics — future dashboard scaffold.
 *
 * The customer entry point currently mounts AuthenticatedBoundary, not App.
 * We retain this component only as an honest zero-data visual foundation.
 * It never connects to a server, opens a WebSocket or fabricates metrics.
 */
import { Activity, Database, LockKeyhole, Server, ShieldCheck } from 'lucide-react';

const sections = [
  {
    title: 'Monitored devices',
    detail: 'Unavailable until an agent is securely enrolled and authorized.',
    icon: Server,
  },
  {
    title: 'Live measurements',
    detail: 'Waiting for authenticated, validated telemetry ingestion.',
    icon: Activity,
  },
  {
    title: 'Historical trends',
    detail: 'No verified persisted measurements are available to display.',
    icon: Database,
  },
];

export default function App() {
  return (
    <main className="min-h-screen bg-neutral-950 px-5 py-10 text-neutral-100">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 pb-6">
          <div className="flex items-center gap-3">
            <Activity className="h-7 w-7 text-cyan-400" aria-hidden="true" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Pulse Metrics</h1>
              <p className="text-sm text-neutral-400">Secure monitoring workspace</p>
            </div>
          </div>
          <span className="rounded-full border border-amber-900 bg-amber-950/40 px-3 py-1 text-xs font-medium text-amber-300">
            Monitoring not enabled
          </span>
        </header>

        <section className="rounded-2xl border border-cyan-950 bg-neutral-900/80 p-7" aria-labelledby="monitoring-title">
          <div className="flex items-start gap-4">
            <LockKeyhole className="mt-1 h-6 w-6 shrink-0 text-cyan-400" aria-hidden="true" />
            <div>
              <h2 id="monitoring-title" className="text-xl font-semibold">Measurements are unavailable</h2>
              <p className="mt-3 max-w-3xl leading-relaxed text-neutral-300">
                Real monitoring requires an authenticated agent, server-side organization authorization,
                validated ingestion and persisted readings. Until these safeguards are verified,
                Pulse Metrics does not display simulated devices, CPU, memory, network or history values.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3" aria-label="Monitoring availability">
          {sections.map(({ title, detail, icon: Icon }) => (
            <div key={title} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
              <Icon className="mb-5 h-6 w-6 text-neutral-400" aria-hidden="true" />
              <h3 className="text-lg font-medium">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">{detail}</p>
              <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-amber-300">Unavailable</p>
            </div>
          ))}
        </section>

        <footer className="flex items-center gap-2 border-t border-neutral-800 pt-6 text-sm text-neutral-400">
          <ShieldCheck className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          Authentication and organization onboarding remain in the separate secure entry screen.
        </footer>
      </div>
    </main>
  );
}
