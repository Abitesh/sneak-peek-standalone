import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  GripVertical,
  MessageSquare,
  Mic,
  Monitor,
  Sparkles,
  Zap,
} from 'lucide-react';

type ModeOption = { id: string; name: string };

type TopControlBarProps = {
  isListening: boolean;
  isProcessing: boolean;
  currentModel: string;
  currentModelDisplayName: string;
  activeModeLabel: string | null;
  inputValue: string;
  onListen: () => void;
  onAnswer: () => void;
  onAsk: () => void;
  onScreen: () => void;
  onModel: (anchor: HTMLElement) => void;
};

const positionKey = 'natively_top_control_bar_position';
const defaultPosition = () => ({ x: window.innerWidth / 2, y: 16 });

export function TopControlBar({
  isListening,
  isProcessing,
  currentModel,
  currentModelDisplayName,
  activeModeLabel,
  inputValue,
  onListen,
  onAnswer,
  onAsk,
  onScreen,
  onModel,
}: TopControlBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState(defaultPosition);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [modes, setModes] = useState<ModeOption[]>([]);
  const [language, setLanguage] = useState('EN');

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(positionKey) || 'null');
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) setPosition(stored);
    } catch { /* use the centered default */ }
    void window.electronAPI?.getAutoAnswerEnabled?.().then(setAutoEnabled).catch(() => {});
    void window.electronAPI?.modesGetAll?.().then((items: any[]) => {
      if (Array.isArray(items)) setModes(items.map((item) => ({ id: item.id, name: item.name })));
    }).catch(() => {});
    void window.electronAPI?.getAiResponseLanguage?.().then((value: string) => {
      if (value) setLanguage(value.slice(0, 2).toUpperCase());
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const keepInBounds = () => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const halfWidth = rect.width / 2;
      const next = {
        x: Math.min(Math.max(position.x, halfWidth + 8), window.innerWidth - halfWidth - 8),
        y: Math.min(Math.max(position.y, 8), Math.max(8, window.innerHeight - rect.height - 8)),
      };
      if (next.x !== position.x || next.y !== position.y) setPosition(next);
    };
    window.addEventListener('resize', keepInBounds);
    return () => window.removeEventListener('resize', keepInBounds);
  }, [position]);

  const updatePosition = (next: { x: number; y: number }) => {
    setPosition(next);
    localStorage.setItem(positionKey, JSON.stringify(next));
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const halfWidth = rect.width / 2;
      updatePosition({
        x: Math.min(Math.max(event.clientX - drag.offsetX, halfWidth + 8), window.innerWidth - halfWidth - 8),
        y: Math.min(Math.max(event.clientY - drag.offsetY, 8), Math.max(8, window.innerHeight - rect.height - 8)),
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - (rect.left + rect.width / 2),
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const stopDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleAuto = async () => {
    const next = !autoEnabled;
    setAutoEnabled(next);
    const result = await window.electronAPI?.setAutoAnswerEnabled?.(next);
    if (result?.success === false) setAutoEnabled(!next);
  };

  const selectMode = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const id = event.target.value;
    if (!id) return;
    await window.electronAPI?.modesSetActive?.(id);
  };

  const controlClass = 'h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg text-[11px] font-medium text-white/75 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const label = currentModelDisplayName || currentModel || 'Default';

  return (
    <div
      ref={barRef}
      className="no-drag fixed z-[400] flex items-center gap-1 rounded-[15px] border border-white/15 bg-[#111216]/85 px-1.5 py-1 shadow-[0_12px_40px_rgba(0,0,0,0.38)] backdrop-blur-2xl select-none pointer-events-auto"
      style={{ left: position.x, top: position.y, transform: 'translateX(-50%)' }}
      role="toolbar"
      aria-label="Natively controls"
    >
      <button
        type="button"
        data-top-control-drag-handle="true"
        className="no-drag h-8 w-7 inline-flex items-center justify-center rounded-lg text-white/55 hover:bg-white/10 hover:text-white cursor-grab active:cursor-grabbing touch-none pointer-events-auto"
        title="Drag toolbar"
        aria-label="Drag toolbar"
        onPointerDown={startDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <GripVertical size={15} />
      </button>

      <div className="h-5 w-px bg-white/15" />
      <button type="button" className={`${controlClass} ${isListening ? 'bg-cyan-400/20 text-cyan-300' : ''}`} onClick={onListen} title={isListening ? 'Stop listening' : 'Start listening'}>
        <Mic size={14} /> <span>Listen</span>
      </button>
      <button type="button" className={`${controlClass} ${autoEnabled ? 'bg-amber-300/20 text-amber-200' : ''}`} onClick={() => void toggleAuto()} title="Toggle automatic answers" aria-pressed={autoEnabled}>
        <Zap size={14} /> <span>Auto</span>
      </button>
      <button type="button" className={`${controlClass} ${isProcessing ? 'text-lime-300' : 'text-lime-200/85'}`} onClick={onAnswer} disabled={isProcessing} title="Answer from the current context">
        <Sparkles size={14} /> <span>Answer</span>
      </button>
      <button type="button" className={controlClass} onClick={onAsk} title={inputValue.trim() ? 'Send question' : 'Focus Ask input'}>
        <MessageSquare size={14} /> <span>Ask</span>
      </button>
      <button type="button" className={controlClass} onClick={onScreen} title="Capture screen context">
        <Monitor size={14} /> <span>Screen</span>
      </button>

      <div className="mx-1 h-5 w-px bg-white/15" />
      <button type="button" className={`${controlClass} max-w-[128px]`} onClick={(event) => onModel(event.currentTarget)} title={`Current model: ${label}`}>
        <span className="truncate">{label}</span><ChevronDown size={12} />
      </button>
      <button type="button" className={controlClass} onClick={() => void window.electronAPI?.openSettingsTab?.('ai-providers')} title="Response language">
        <span className="text-cyan-200">{language}</span>
      </button>
      <select
        aria-label="Response mode"
        title="Response mode"
        value={modes.find((mode) => mode.name === activeModeLabel)?.id || ''}
        onChange={(event) => void selectMode(event)}
        className="h-8 max-w-[112px] appearance-none rounded-lg bg-transparent px-2 text-[11px] font-medium text-white/75 outline-none hover:bg-white/10"
      >
        <option value="" className="bg-[#17181d]">Standard</option>
        {modes.map((mode) => <option key={mode.id} value={mode.id} className="bg-[#17181d]">{mode.name}</option>)}
      </select>
    </div>
  );
}
