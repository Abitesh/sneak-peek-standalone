import React, { useState, useEffect } from 'react';

interface ModelConfig {
  provider: "ollama" | "gemini";
  model: string;
  isOllama: boolean;
}

interface ModelSelectorProps {
  onModelChange?: (provider: "ollama" | "gemini", model: string) => void;
  onChatOpen?: () => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ onModelChange, onChatOpen }) => {
  const [currentConfig, setCurrentConfig] = useState<ModelConfig | null>(null);
  const [availableOllamaModels, setAvailableOllamaModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<'testing' | 'success' | 'error' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<"ollama" | "gemini">("gemini");
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>("");
  const [selectedGeminiModel, setSelectedGeminiModel] = useState<string>("gemini-3-flash-preview");
  const [ollamaUrl, setOllamaUrl] = useState<string>("http://localhost:11434");

  const GEMINI_MODELS = [
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Fast & Multimodal)' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Text Reasoning)' },
  ];

  useEffect(() => {
    loadCurrentConfig();
  }, []);

  const loadCurrentConfig = async () => {
    try {
      setIsLoading(true);
      const config = await window.electronAPI.getCurrentLlmConfig();
      setCurrentConfig(config);
      setSelectedProvider(config.provider);

      if (config.isOllama) {
        setSelectedOllamaModel(config.model);
        await loadOllamaModels();
      } else {
        setSelectedGeminiModel(config.model);
      }
    } catch (error) {
      console.error('Error loading current config:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadOllamaModels = async () => {
    try {
      const models = await window.electronAPI.getAvailableOllamaModels();
      setAvailableOllamaModels(models);

      // Auto-select first model if none selected
      if (models.length > 0 && !selectedOllamaModel) {
        setSelectedOllamaModel(models[0]);
      }
    } catch (error) {
      console.error('Error loading Ollama models:', error);
      setAvailableOllamaModels([]);
    }
  };

  const testConnection = async () => {
    try {
      setConnectionStatus('testing');
      const result = await window.electronAPI.testLlmConnection();
      setConnectionStatus(result.success ? 'success' : 'error');
      if (!result.success) {
        setErrorMessage(result.error || 'Unknown error');
      }
    } catch (error) {
      setConnectionStatus('error');
      setErrorMessage(String(error));
    }
  };

  const handleProviderSwitch = async () => {
    try {
      setConnectionStatus('testing');
      let result;

      if (selectedProvider === 'ollama') {
        result = await window.electronAPI.switchToOllama(selectedOllamaModel, ollamaUrl);
      } else {
        // @ts-ignore - switchToGemini accepts 2 arguments
        result = await (window.electronAPI as any).switchToGemini(geminiApiKey || undefined, selectedGeminiModel);
      }

      if (result.success) {
        await loadCurrentConfig();
        setConnectionStatus('success');
        onModelChange?.(selectedProvider, selectedProvider === 'ollama' ? selectedOllamaModel : selectedGeminiModel);
        // Auto-open chat window after successful model change
        setTimeout(() => {
          onChatOpen?.();
        }, 500);
      } else {
        setConnectionStatus('error');
        setErrorMessage(result.error || 'Switch failed');
      }
    } catch (error) {
      setConnectionStatus('error');
      setErrorMessage(String(error));
    }
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'testing': return 'text-yellow-600';
      case 'success': return 'text-green-600';
      case 'error': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'testing': return 'Testing connection...';
      case 'success': return 'Connected successfully';
      case 'error': return `Error: ${errorMessage}`;
      default: return 'Ready';
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 bg-[#1E1E1E]/95 backdrop-blur-2xl rounded-[18px] border border-white/10 animate-fade-in-up">
        <div className="animate-pulse text-xs text-slate-400 font-medium">Loading model configuration...</div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-[#1E1E1E]/95 backdrop-blur-2xl rounded-[18px] border border-white/10 shadow-2xl shadow-black/40 space-y-4 animate-fade-in-up">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-200">AI Model Selection</h3>
        <div className={`text-[10px] font-medium tracking-wide uppercase ${getStatusColor()}`}>
          {getStatusText()}
        </div>
      </div>

      {/* Current Status */}
      {currentConfig && (
        <div className="text-[11px] font-medium text-slate-400 bg-white/5 border border-white/5 p-2.5 rounded-lg flex items-center gap-2">
          <span>{currentConfig.provider === 'ollama' ? '🏠' : '☁️'}</span>
          <span className="text-slate-200">{currentConfig.model}</span>
        </div>
      )}

      {/* Provider Selection */}
      <div className="space-y-2">
        <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Provider</label>
        <div className="flex gap-2 p-1 bg-black/20 rounded-lg border border-white/5">
          <button
            onClick={() => setSelectedProvider('gemini')}
            className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all duration-200 ${selectedProvider === 'gemini'
              ? 'bg-[#1E1E1E] text-white shadow-sm border border-white/10'
              : 'text-slate-500 hover:text-slate-300'
              }`}
          >
            Gemini
          </button>
          <button
            onClick={() => setSelectedProvider('ollama')}
            className={`flex-1 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all duration-200 ${selectedProvider === 'ollama'
              ? 'bg-[#1E1E1E] text-white shadow-sm border border-white/10'
              : 'text-slate-500 hover:text-slate-300'
              }`}
          >
            Ollama
          </button>
        </div>
      </div>

      {/* Provider-specific settings */}
      {selectedProvider === 'gemini' ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Gemini API Key</label>
            <input
              type="password"
              placeholder="Enter API key..."
              value={geminiApiKey}
              onChange={(e) => setGeminiApiKey(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-black/20 border border-white/5 rounded-lg text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-white/20 focus:bg-black/40 transition-all font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Model</label>
            <div className="relative">
              <select
                value={selectedGeminiModel}
                onChange={(e) => setSelectedGeminiModel(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-black/20 border border-white/5 rounded-lg text-slate-200 appearance-none focus:outline-none focus:border-white/20 focus:bg-black/40 transition-all cursor-pointer"
              >
                {GEMINI_MODELS.map((m) => (
                  <option key={m.id} value={m.id} className="bg-[#1E1E1E] text-slate-200">
                    {m.name}
                  </option>
                ))}
              </select>
              <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 1L5 5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Ollama URL</label>
            <input
              type="url"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-black/20 border border-white/5 rounded-lg text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-white/20 focus:bg-black/40 transition-all font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Model</label>
              <button
                onClick={loadOllamaModels}
                className="text-[10px] text-slate-400 hover:text-white transition-colors flex items-center gap-1"
                title="Refresh models"
              >
                Refresh <span className="opacity-50">↻</span>
              </button>
            </div>

            {availableOllamaModels.length > 0 ? (
              <div className="relative">
                <select
                  value={selectedOllamaModel}
                  onChange={(e) => setSelectedOllamaModel(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-black/20 border border-white/5 rounded-lg text-slate-200 appearance-none focus:outline-none focus:border-white/20 focus:bg-black/40 transition-all cursor-pointer"
                >
                  {availableOllamaModels.map((model) => (
                    <option key={model} value={model} className="bg-[#1E1E1E] text-slate-200">
                      {model}
                    </option>
                  ))}
                </select>
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L5 5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-yellow-400/80 bg-yellow-500/10 border border-yellow-500/20 p-2.5 rounded-lg">
                No Ollama models found. Ensure Ollama is running.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 pt-2">
        <button
          onClick={handleProviderSwitch}
          disabled={connectionStatus === 'testing'}
          className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-[11px] font-semibold rounded-lg transition-all shadow-lg shadow-blue-500/20 interaction-base interaction-press"
        >
          {connectionStatus === 'testing' ? 'Switching...' : 'Apply Changes'}
        </button>

        <button
          onClick={testConnection}
          disabled={connectionStatus === 'testing'}
          className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/5 disabled:opacity-50 text-slate-300 text-[11px] font-medium rounded-lg transition-all interaction-base interaction-press"
        >
          Test
        </button>
      </div>
    </div>
  );
};

export default ModelSelector;