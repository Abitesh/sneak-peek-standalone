import React, { useEffect, useState } from 'react';
import {
  AudioLines,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Mic,
  Monitor,
  Sparkles,
  Zap,
} from 'lucide-react';

type ModeOption = { id: string; name: string };

type TopControlBarProps = {
  isListening: boolean;
  /** True while a Listen turn is being finalized/sent to the AI (Transcribing/Processing). */
  isAnalyzing?: boolean;
  isProcessing: boolean;
  currentModel: string;
  currentModelDisplayName: string;
  activeModeLabel: string | null;
  inputValue: string;
  onListen: () => void;
  onAnalyze: () => void;
  onAnswer: () => void;
  onAsk: () => void;
  onScreen: () => void;
  onModel: (anchor: HTMLElement) => void;
};

const collapsedKey = 'natively_top_control_bar_collapsed';

export function TopControlBar({
  isListening,
  isAnalyzing = false,
  isProcessing,
  currentModel,
  currentModelDisplayName,
  activeModeLabel,
  inputValue,
  onListen,
  onAnalyze,
  onAnswer,
  onAsk,
  onScreen,
  onModel,
}: TopControlBarProps) {
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [modes, setModes] = useState<ModeOption[]>([]);
  const [language, setLanguage] = useState('EN');
  // Non-blocking overlay (Problem 48): collapsing the bar to a chevron +
  // status dot lets the user reclaim space over the chat transcript.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapsedKey) === 'true');

  useEffect(() => {
    void window.electronAPI?.getAutoAnswerEnabled?.().then(setAutoEnabled).catch(() => {});
    void window.electronAPI?.modesGetAll?.().then((items: any[]) => {
      if (Array.isArray(items)) setModes(items.map((item) => ({ id: item.id, name: item.name })));
    }).catch(() => {});
    void window.electronAPI?.getAiResponseLanguage?.().then((value: string) => {
      if (value) setLanguage(value.slice(0, 2).toUpperCase());
    }).catch(() => {});
  }, []);

  const toggleAuto = async () => {
    const next = !autoEnabled;
    setAutoEnabled(next);
    const result = await window.electronAPI?.setAutoAnswerEnabled?.(next);
    if (result?.success === false) setAutoEnabled(!next);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(collapsedKey, String(next));
  };

  const selectMode = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const id = event.target.value;
    if (!id) return;
    await window.electronAPI?.modesSetActive?.(id);
  };

  const controlClass = 'h-8 shrink-0 px-2.5 inline-flex items-center gap-1.5 rounded-lg text-[11px] font-medium text-white/75 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const label = currentModelDisplayName || currentModel || 'Default';

  return (
    <div
      data-top-control-bar="true"
      className="no-drag relative z-20 flex w-full min-w-0 items-center gap-1 overflow-x-auto border-b border-white/10 bg-black/25 px-2 py-1.5 select-none pointer-events-auto"
      role="toolbar"
      aria-label="Natively controls"
    >
      {collapsed ? (
        <>
          {(isListening || isAnalyzing) && (
            <div
              className={`h-2 w-2 rounded-full animate-pulse ${isAnalyzing ? 'bg-violet-400' : 'bg-cyan-400'}`}
              title={isAnalyzing ? 'Analyzing…' : 'Listening…'}
            />
          )}
          <button
            type="button"
            className={controlClass}
            onClick={toggleCollapsed}
            title="Expand toolbar"
            aria-label="Expand toolbar"
            aria-pressed={false}
          >
            <ChevronRight size={14} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={`${controlClass} ${isListening ? 'bg-cyan-400/20 text-cyan-300' : ''}`}
            onClick={onListen}
            disabled={isListening || isAnalyzing}
            title={isListening ? 'Listening…' : 'Start listening'}
          >
            <Mic size={14} /> <span>Listen</span>
          </button>
          <button
            type="button"
            className={`${controlClass} ${isAnalyzing ? 'bg-violet-400/20 text-violet-300' : ''}`}
            onClick={onAnalyze}
            disabled={!isListening || isAnalyzing}
            title={isListening ? 'Stop listening and get an answer' : 'Start listening first'}
          >
            <AudioLines size={14} /> <span>Analyze</span>
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

          <div className="mx-1 h-5 w-px bg-white/15" />
          <button
            type="button"
            className={`${controlClass} !px-1.5`}
            onClick={toggleCollapsed}
            title="Collapse toolbar"
            aria-label="Collapse toolbar"
            aria-pressed
          >
            <ChevronLeft size={14} />
          </button>
        </>
      )}
    </div>
  );
}
