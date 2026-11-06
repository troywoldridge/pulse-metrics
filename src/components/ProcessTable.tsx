import React, { useState } from 'react';
import { ProcessItem } from '../types/metrics';
import { formatBytes } from '../utils/metrics-calculator';
import { Layers, ArrowUpDown, Search } from 'lucide-react';

interface ProcessTableProps {
  processes: ProcessItem[];
}

export const ProcessTable: React.FC<ProcessTableProps> = ({ processes }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'cpu' | 'mem'>('cpu');

  const filtered = processes
    .filter((p) => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.pid.toString().includes(searchTerm))
    .sort((a, b) => (sortBy === 'cpu' ? b.cpuPercent - a.cpuPercent : b.memPercent - a.memPercent));

  return (
    <div className="flex flex-col p-4 bg-neutral-900/90 dark:bg-neutral-900 border border-neutral-800 rounded-xl relative shadow-sm hover:border-neutral-700 transition-all">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 text-xs text-neutral-200 font-medium">
          <Layers className="w-3.5 h-3.5 text-indigo-400" />
          <span>Active Processes ({processes.length})</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Search input */}
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-2 text-neutral-500" />
            <input
              type="text"
              placeholder="Filter PID or name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-6 pr-2 py-1 text-[11px] font-mono bg-neutral-800/80 border border-neutral-700 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-indigo-500 w-36"
            />
          </div>

          {/* Sort toggle */}
          <div className="flex items-center gap-1 bg-neutral-800/60 p-0.5 rounded text-[11px] font-mono">
            <button
              onClick={() => setSortBy('cpu')}
              className={`px-2 py-0.5 rounded transition-all cursor-pointer ${
                sortBy === 'cpu' ? 'bg-indigo-600 text-white font-medium' : 'text-neutral-400 hover:text-white'
              }`}
            >
              % CPU
            </button>
            <button
              onClick={() => setSortBy('mem')}
              className={`px-2 py-0.5 rounded transition-all cursor-pointer ${
                sortBy === 'mem' ? 'bg-indigo-600 text-white font-medium' : 'text-neutral-400 hover:text-white'
              }`}
            >
              % MEM
            </button>
          </div>
        </div>
      </div>

      {/* Process Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-[11px] tabular-nums">
          <thead>
            <tr className="border-b border-neutral-800 text-neutral-400 text-[10px] uppercase">
              <th className="pb-1.5 font-medium">PID</th>
              <th className="pb-1.5 font-medium">Process</th>
              <th className="pb-1.5 font-medium">User</th>
              <th className="pb-1.5 font-medium text-right">% CPU</th>
              <th className="pb-1.5 font-medium text-right">% MEM</th>
              <th className="pb-1.5 font-medium text-right">RSS</th>
              <th className="pb-1.5 font-medium text-center">Stat</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/50">
            {filtered.map((proc) => (
              <tr key={proc.pid} className="hover:bg-neutral-800/40 transition-colors">
                <td className="py-1.5 text-neutral-400">{proc.pid}</td>
                <td className="py-1.5 text-neutral-200 font-semibold truncate max-w-[120px]" title={proc.name}>
                  {proc.name}
                </td>
                <td className="py-1.5 text-neutral-400">{proc.user}</td>
                <td className="py-1.5 text-right font-medium text-emerald-400">{proc.cpuPercent}%</td>
                <td className="py-1.5 text-right text-blue-400">{proc.memPercent}%</td>
                <td className="py-1.5 text-right text-neutral-300">{formatBytes(proc.memBytes)}</td>
                <td className="py-1.5 text-center">
                  <span className={`px-1 rounded text-[9px] ${proc.status === 'R' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50' : 'bg-neutral-800 text-neutral-400'}`}>
                    {proc.status}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-center text-neutral-500">
                  No matching processes found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
