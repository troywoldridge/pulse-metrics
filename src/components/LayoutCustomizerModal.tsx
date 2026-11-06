import React from 'react';
import { WidgetLayoutConfig } from '../types/metrics';
import { X, Eye, EyeOff, MoveUp, MoveDown, LayoutGrid, Check } from 'lucide-react';

interface LayoutCustomizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  widgets: WidgetLayoutConfig[];
  onUpdateWidgets: (widgets: WidgetLayoutConfig[]) => void;
  viewMode: 'grid' | 'compact' | 'focus';
  onUpdateViewMode: (mode: 'grid' | 'compact' | 'focus') => void;
  onResetDefaults: () => void;
}

export const LayoutCustomizerModal: React.FC<LayoutCustomizerModalProps> = ({
  isOpen,
  onClose,
  widgets,
  onUpdateWidgets,
  viewMode,
  onUpdateViewMode,
  onResetDefaults,
}) => {
  if (!isOpen) return null;

  const toggleVisibility = (id: string) => {
    const next = widgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w));
    onUpdateWidgets(next);
  };

  const moveWidget = (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= widgets.length) return;

    const copy = [...widgets];
    const temp = copy[index];
    copy[index] = copy[targetIdx];
    copy[targetIdx] = temp;

    // re-assign order numbers
    copy.forEach((w, i) => (w.order = i));
    onUpdateWidgets(copy);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800 bg-neutral-950/50">
          <div className="flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-neutral-200">Customize Dashboard Layout</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
            aria-label="Close layout manager"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          {/* View mode toggle */}
          <div>
            <label className="text-xs font-medium text-neutral-400 block mb-1.5">
              Dashboard View Mode
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['grid', 'compact', 'focus'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => onUpdateViewMode(mode)}
                  className={`py-2 px-3 text-xs font-medium rounded-lg border text-center capitalize transition-all cursor-pointer ${
                    viewMode === mode
                      ? 'bg-cyan-600/20 border-cyan-500 text-cyan-300 shadow-xs'
                      : 'bg-neutral-800/60 border-neutral-700/60 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {mode} View
                </button>
              ))}
            </div>
          </div>

          {/* Widgets reorder and toggle */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-neutral-400">
                Visible Widgets &amp; Ordering
              </label>
              <button
                onClick={onResetDefaults}
                className="text-[11px] text-cyan-400 hover:underline cursor-pointer"
              >
                Reset Defaults
              </button>
            </div>

            <div className="space-y-1.5">
              {widgets.map((widget, idx) => (
                <div
                  key={widget.id}
                  className={`flex items-center justify-between p-2.5 rounded-lg border transition-all ${
                    widget.visible
                      ? 'bg-neutral-800/70 border-neutral-700/70 text-neutral-200'
                      : 'bg-neutral-900/60 border-neutral-800/80 text-neutral-500 opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <button
                      onClick={() => toggleVisibility(widget.id)}
                      className={`p-1 rounded cursor-pointer ${
                        widget.visible ? 'text-cyan-400 hover:bg-neutral-700' : 'text-neutral-500 hover:text-neutral-300'
                      }`}
                      aria-label={widget.visible ? `Hide ${widget.name}` : `Show ${widget.name}`}
                    >
                      {widget.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <span className="text-xs font-medium">{widget.name}</span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => moveWidget(idx, 'up')}
                      disabled={idx === 0}
                      className="p-1 rounded hover:bg-neutral-700 disabled:opacity-30 text-neutral-400 cursor-pointer"
                      aria-label="Move Up"
                    >
                      <MoveUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => moveWidget(idx, 'down')}
                      disabled={idx === widgets.length - 1}
                      className="p-1 rounded hover:bg-neutral-700 disabled:opacity-30 text-neutral-400 cursor-pointer"
                      aria-label="Move Down"
                    >
                      <MoveDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-neutral-800 bg-neutral-950/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply Layout</span>
          </button>
        </div>
      </div>
    </div>
  );
};
