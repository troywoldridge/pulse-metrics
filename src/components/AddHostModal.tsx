import React, { useState } from 'react';
import { X, Server, Plus, Terminal } from 'lucide-react';

interface AddHostModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddHost: (data: {
    name: string;
    hostname: string;
    sshCommand: string;
    connectionType: 'ssh' | 'local' | 'agent';
  }) => void;
}

export const AddHostModal: React.FC<AddHostModalProps> = ({
  isOpen,
  onClose,
  onAddHost,
}) => {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [sshCommand, setSshCommand] = useState('ssh ');
  const [connectionType, setConnectionType] = useState<'ssh' | 'local' | 'agent'>('ssh');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !hostname.trim()) return;

    onAddHost({
      name: name.trim(),
      hostname: hostname.trim(),
      sshCommand: sshCommand.trim() || `ssh ${hostname.trim()}`,
      connectionType,
    });
    setName('');
    setHostname('');
    setSshCommand('ssh ');
    onClose();
  };

  const handleHostnameChange = (val: string) => {
    setHostname(val);
    if (sshCommand === 'ssh ' || sshCommand.startsWith('ssh ')) {
      setSshCommand(`ssh ${val}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800 bg-neutral-950/50">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-neutral-200">Add Target Server</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3.5">
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              Server Display Name
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Production Cluster or HomeLab Alpha"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs font-mono text-neutral-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              Hostname or Shortcut Target
            </label>
            <input
              type="text"
              required
              placeholder="e.g. work, debian-node, 192.168.1.150"
              value={hostname}
              onChange={(e) => handleHostnameChange(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs font-mono text-neutral-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              SSH Invocation Command
            </label>
            <div className="relative">
              <Terminal className="w-3.5 h-3.5 absolute left-3 top-2.5 text-neutral-500" />
              <input
                type="text"
                placeholder="ssh work or ssh -p 2222 user@host"
                value={sshCommand}
                onChange={(e) => setSshCommand(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-neutral-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">
              Supports shortcuts configured in your SSH configuration (such as <code className="text-emerald-400">ssh work</code>).
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1">
              Connection Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConnectionType('ssh')}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium border text-center cursor-pointer transition-all ${
                  connectionType === 'ssh'
                    ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-400'
                }`}
              >
                Direct SSH Pipe
              </button>
              <button
                type="button"
                onClick={() => setConnectionType('agent')}
                className={`py-1.5 px-3 rounded-lg text-xs font-medium border text-center cursor-pointer transition-all ${
                  connectionType === 'agent'
                    ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-400'
                }`}
              >
                Telemetry Daemon
              </button>
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-400 hover:text-white text-xs cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Server</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
