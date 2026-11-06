import React, { useState } from 'react';
import { ServerLogItem, HostMetrics } from '../types/metrics';
import { Terminal, Send, RefreshCw, X, HelpCircle, Check, Copy } from 'lucide-react';

interface SshTerminalDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  host: HostMetrics;
  onExecuteCommand: (command: string, hostId: string) => void;
  lastExecResult?: {
    command: string;
    output: string;
    success: boolean;
    timestamp: number;
  } | null;
}

export const SshTerminalDrawer: React.FC<SshTerminalDrawerProps> = ({
  isOpen,
  onClose,
  host,
  onExecuteCommand,
  lastExecResult,
}) => {
  const [inputCmd, setInputCmd] = useState('');
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [showConfigHelp, setShowConfigHelp] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCmd.trim()) return;
    onExecuteCommand(inputCmd.trim(), host.hostId);
    setInputCmd('');
  };

  const quickCommands = [
    { label: 'Uptime', cmd: 'uptime' },
    { label: 'Memory Free', cmd: 'free -h' },
    { label: 'Disk Space', cmd: 'df -h' },
    { label: 'Kernel Info', cmd: 'uname -a' },
    { label: 'Top Procs', cmd: 'ps aux --sort=-%cpu | head -n 6' },
    { label: 'Netstat', cmd: 'ss -tuln' },
  ];

  const sampleSshConfig = `# Add this to ~/.ssh/config on your Linux PC:
Host work
  HostName <YOUR_WORK_SERVER_IP_OR_HOSTNAME>
  User <YOUR_REMOTE_USERNAME>
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 15
  ServerAliveCountMax 3`;

  const copyConfig = () => {
    navigator.clipboard.writeText(sampleSshConfig);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end transition-opacity">
      <div className="w-full max-w-2xl bg-neutral-950 border-l border-neutral-800 h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-900/60">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="font-mono text-sm font-semibold text-neutral-200">
              SSH Console: {host.sshCommand}
            </span>
            <span className="text-xs px-2 py-0.5 rounded font-mono bg-neutral-800 text-neutral-400">
              {host.connectionHealth.state.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowConfigHelp(!showConfigHelp)}
              className="text-xs text-neutral-400 hover:text-neutral-200 flex items-center gap-1 px-2 py-1 rounded bg-neutral-800/80 cursor-pointer"
              title="SSH Shortcut Configuration Help"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Config Help</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
              aria-label="Close terminal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* SSH Config Helper Banner (collapsible) */}
        {showConfigHelp && (
          <div className="p-3 bg-neutral-900 border-b border-neutral-800 text-xs font-mono">
            <div className="flex items-center justify-between text-neutral-300 font-semibold mb-1">
              <span>Automatic Authentication via 'ssh work'</span>
              <button
                onClick={copyConfig}
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 cursor-pointer"
              >
                {copiedConfig ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedConfig ? 'Copied' : 'Copy Config'}</span>
              </button>
            </div>
            <pre className="p-2 bg-neutral-950 rounded text-neutral-400 text-[11px] overflow-x-auto border border-neutral-800 select-all">
              {sampleSshConfig}
            </pre>
            <p className="text-[11px] text-neutral-500 mt-1">
              Once configured in ~/.ssh/config, simply running <code className="text-emerald-400">ssh work</code> authenticates without prompts using public key crypto.
            </p>
          </div>
        )}

        {/* Quick action command buttons */}
        <div className="flex items-center gap-1.5 px-4 py-2 bg-neutral-900/40 border-b border-neutral-800/60 overflow-x-auto text-[11px] font-mono">
          <span className="text-neutral-500 shrink-0">Quick Cmds:</span>
          {quickCommands.map((qc) => (
            <button
              key={qc.cmd}
              onClick={() => onExecuteCommand(qc.cmd, host.hostId)}
              className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors whitespace-nowrap cursor-pointer shrink-0"
            >
              {qc.label}
            </button>
          ))}
        </div>

        {/* Console Log stream & execution output */}
        <div className="flex-1 p-4 font-mono text-xs overflow-y-auto space-y-2 select-text bg-neutral-950 text-neutral-300">
          <div className="text-neutral-500 text-[11px] pb-2 border-b border-neutral-900">
            --- Target: {host.name} ({host.hostname}) | Connection: {host.connectionType} ---
            <br />
            Status: {host.connectionHealth.diagnosticsMessage}
          </div>

          {/* Logs */}
          {host.logs.map((log) => (
            <div key={log.id} className="leading-relaxed">
              <span className="text-neutral-600 text-[10px] mr-2">
                [{new Date(log.timestamp).toLocaleTimeString()}]
              </span>
              <span
                className={
                  log.level === 'error'
                    ? 'text-rose-400'
                    : log.level === 'ssh'
                    ? 'text-emerald-400'
                    : log.level === 'warn'
                    ? 'text-amber-400'
                    : 'text-neutral-300'
                }
              >
                {log.message}
              </span>
            </div>
          ))}

          {/* Most recent interactive exec result */}
          {lastExecResult && (
            <div className="mt-4 p-2.5 rounded bg-neutral-900/80 border border-neutral-800">
              <div className="text-emerald-400 font-semibold mb-1 flex items-center justify-between">
                <span>$ {lastExecResult.command}</span>
                <span className="text-[10px] text-neutral-500">
                  {new Date(lastExecResult.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <pre className="text-neutral-300 text-[11px] whitespace-pre-wrap font-mono">
                {lastExecResult.output || '(No output returned)'}
              </pre>
            </div>
          )}
        </div>

        {/* Command Input Form */}
        <form onSubmit={handleSubmit} className="p-3 border-t border-neutral-800 bg-neutral-900/60 flex items-center gap-2">
          <span className="text-emerald-400 font-mono text-sm pl-2">$</span>
          <input
            type="text"
            value={inputCmd}
            onChange={(e) => setInputCmd(e.target.value)}
            placeholder={`Execute command on ${host.hostname}... (e.g. uptime, top, ls -la)`}
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-xs font-mono text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Run</span>
          </button>
        </form>
      </div>
    </div>
  );
};
