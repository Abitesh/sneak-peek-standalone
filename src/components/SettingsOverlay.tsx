import React, { useState, useEffect } from 'react';
import {
    X, Mic, Speaker, Monitor, Keyboard, User, LifeBuoy, LogOut,
    Command, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
    AppWindow, Camera, RotateCcw, Eye, Layout, MessageSquare, Crop,
    ChevronDown, Check, BadgeCheck, Power, Palette, Calendar, Ghost, Sun, Moon, RefreshCw, Info, Globe, FlaskConical
} from 'lucide-react';
import { AboutSection } from './AboutSection';
import { motion, AnimatePresence } from 'framer-motion';

interface CustomSelectProps {
    label: string;
    icon: React.ReactNode;
    value: string;
    options: MediaDeviceInfo[];
    onChange: (value: string) => void;
    placeholder?: string;
}

const CustomSelect: React.FC<CustomSelectProps> = ({ label, icon, value, options, onChange, placeholder = "Select device" }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selectedLabel = options.find(o => o.deviceId === value)?.label || placeholder;

    return (
        <div className="bg-bg-card rounded-xl p-4 border border-border-subtle" ref={containerRef}>
            {label && (
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-text-secondary">{icon}</span>
                    <label className="text-xs font-medium text-text-secondary uppercase tracking-wide">{label}</label>
                </div>
            )}

            <div className="relative">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary flex items-center justify-between hover:bg-bg-elevated transition-colors"
                >
                    <span className="truncate pr-4">{selectedLabel}</span>
                    <ChevronDown size={14} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>

                {isOpen && (
                    <div className="absolute top-full left-0 w-full mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl z-50 max-h-48 overflow-y-auto animated fadeIn">
                        <div className="p-1 space-y-0.5">
                            {options.map((device) => (
                                <button
                                    key={device.deviceId}
                                    onClick={() => {
                                        onChange(device.deviceId);
                                        setIsOpen(false);
                                    }}
                                    className={`w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between group transition-colors ${value === device.deviceId ? 'bg-bg-input hover:bg-bg-elevated text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                >
                                    <span className="truncate">{device.label || `Device ${device.deviceId.slice(0, 5)}...`}</span>
                                    {value === device.deviceId && <Check size={14} className="text-accent-primary" />}
                                </button>
                            ))}
                            {options.length === 0 && (
                                <div className="px-3 py-2 text-sm text-gray-500 italic">No devices found</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

interface SettingsOverlayProps {
    isOpen: boolean;
    onClose: () => void;
}

const SettingsOverlay: React.FC<SettingsOverlayProps> = ({ isOpen, onClose }) => {
    const [activeTab, setActiveTab] = useState('general');
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [openOnLogin, setOpenOnLogin] = useState(false);
    const [themeMode, setThemeMode] = useState<'system' | 'light' | 'dark'>('system');
    const [isThemeDropdownOpen, setIsThemeDropdownOpen] = useState(false);
    const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'uptodate' | 'error'>('idle');
    const themeDropdownRef = React.useRef<HTMLDivElement>(null);

    // Close dropdown when clicking outside
    // Sync with global state changes
    useEffect(() => {
        if (window.electronAPI?.onUndetectableChanged) {
            const unsubscribe = window.electronAPI.onUndetectableChanged((newState: boolean) => {
                setIsUndetectable(newState);
            });
            return () => unsubscribe();
        }
    }, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (themeDropdownRef.current && !themeDropdownRef.current.contains(event.target as Node)) {
                setIsThemeDropdownOpen(false);
            }
        };

        if (isThemeDropdownOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isThemeDropdownOpen]);

    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem('natively_interviewer_transcript');
        return stored !== 'false';
    });

    // Recognition Language
    const [recognitionLanguage, setRecognitionLanguage] = useState('');
    const [availableLanguages, setAvailableLanguages] = useState<Record<string, any>>({});
    const [languageOptions, setLanguageOptions] = useState<any[]>([]);

    useEffect(() => {
        const loadLanguages = async () => {
            if (window.electronAPI?.getRecognitionLanguages) {
                const langs = await window.electronAPI.getRecognitionLanguages();
                setAvailableLanguages(langs);

                // Define the specific order and labels requested by user
                const desiredOrder = [
                    { key: 'english-india', label: 'English (India)' },
                    { key: 'english-us', label: 'English (United States)' },
                    { key: 'english-uk', label: 'English (United Kingdom)' },
                    { key: 'english-au', label: 'English (Australia)' },
                    { key: 'english-ca', label: 'English (Canada)' },
                ];

                // Create options list starting with Auto
                const options = [
                    {
                        deviceId: 'auto',
                        label: 'Auto (Recommended)',
                        kind: 'audioinput' as MediaDeviceKind,
                        groupId: '',
                        toJSON: () => ({})
                    }
                ];

                // Add the rest if they exist in backend response
                desiredOrder.forEach(({ key, label }) => {
                    if (langs[key]) {
                        options.push({
                            deviceId: key,
                            label: label, // Use requested label
                            kind: 'audioinput' as MediaDeviceKind,
                            groupId: '',
                            toJSON: () => ({})
                        });
                    }
                });

                setLanguageOptions(options);

                // Load stored preference
                const stored = localStorage.getItem('natively_recognition_language');

                // If stored is 'auto' or not set, default to 'auto'
                if (!stored || stored === 'auto') {
                    setRecognitionLanguage('auto');
                    // We still need to set the actual backend language based on system locale
                    // But for UI, we show 'auto'
                    applyAutoLanguage(langs);
                } else if (langs[stored]) {
                    setRecognitionLanguage(stored);
                } else {
                    // Fallback if stored key no longer exists
                    setRecognitionLanguage('auto');
                    applyAutoLanguage(langs);
                }
            }
        };
        loadLanguages();
    }, []);

    const applyAutoLanguage = (langs: any) => {
        const systemLocale = navigator.language;
        let match = 'english-us';

        // Logic to find best match from available langs
        for (const [key, config] of Object.entries(langs)) {
            if ((config as any).primary === systemLocale || (config as any).alternates.includes(systemLocale)) {
                match = key;
                break;
            }
        }
        if (systemLocale === 'en-IN') match = 'english-india';

        // Send actual code to backend, but keep UI as 'auto' (handled by separating state if needed, 
        // but here 'recognitionLanguage' state tracks the dropdown value)
        if (window.electronAPI?.setRecognitionLanguage) {
            window.electronAPI.setRecognitionLanguage(match);
        }
    };

    const handleLanguageChange = (key: string) => {
        setRecognitionLanguage(key);
        localStorage.setItem('natively_recognition_language', key);

        if (key === 'auto') {
            applyAutoLanguage(availableLanguages);
        } else {
            if (window.electronAPI?.setRecognitionLanguage) {
                window.electronAPI.setRecognitionLanguage(key);
            }
        }
    };


    // Sync transcript setting
    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem('natively_interviewer_transcript');
            setShowTranscript(stored !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    // Theme Handlers
    const handleSetTheme = async (mode: 'system' | 'light' | 'dark') => {
        setThemeMode(mode);
        if (window.electronAPI?.setThemeMode) {
            await window.electronAPI.setThemeMode(mode);
        }
    };

    // Audio Settings
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedInput, setSelectedInput] = useState('');
    const [selectedOutput, setSelectedOutput] = useState('');
    const [micLevel, setMicLevel] = useState(0);
    const [useLegacyAudio, setUseLegacyAudio] = useState(false);

    const [apiKey, setApiKey] = useState('');
    const [groqApiKey, setGroqApiKey] = useState('');
    const [openaiApiKey, setOpenaiApiKey] = useState('');
    const [claudeApiKey, setClaudeApiKey] = useState('');
    const [apiKeySaving, setApiKeySaving] = useState(false);
    const [groqKeySaving, setGroqKeySaving] = useState(false);
    const [openaiKeySaving, setOpenaiKeySaving] = useState(false);
    const [claudeKeySaving, setClaudeKeySaving] = useState(false);
    const [apiKeySaved, setApiKeySaved] = useState(false);
    const [groqKeySaved, setGroqKeySaved] = useState(false);
    const [openaiKeySaved, setOpenaiKeySaved] = useState(false);
    const [claudeKeySaved, setClaudeKeySaved] = useState(false);
    const [hasStoredGeminiKey, setHasStoredGeminiKey] = useState(false);
    const [hasStoredGroqKey, setHasStoredGroqKey] = useState(false);
    const [hasStoredOpenaiKey, setHasStoredOpenaiKey] = useState(false);
    const [hasStoredClaudeKey, setHasStoredClaudeKey] = useState(false);

    const [serviceAccountPath, setServiceAccountPath] = useState('');
    const [calendarStatus, setCalendarStatus] = useState<{ connected: boolean; email?: string }>({ connected: false });
    const [isCalendarsLoading, setIsCalendarsLoading] = useState(false);

    const audioContextRef = React.useRef<AudioContext | null>(null);
    const analyserRef = React.useRef<AnalyserNode | null>(null);
    const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
    const rafRef = React.useRef<number | null>(null);
    const streamRef = React.useRef<MediaStream | null>(null);

    // Load stored credentials on mount
    useEffect(() => {
        const loadStoredCredentials = async () => {
            try {
                // @ts-ignore  
                const creds = await window.electronAPI?.getStoredCredentials?.();
                if (creds) {
                    setHasStoredGeminiKey(creds.hasGeminiKey);
                    setHasStoredGroqKey(creds.hasGroqKey);
                    setHasStoredOpenaiKey(creds.hasOpenaiKey);
                    setHasStoredClaudeKey(creds.hasClaudeKey);
                    if (creds.googleServiceAccountPath) {
                        setServiceAccountPath(creds.googleServiceAccountPath);
                    }
                }
            } catch (e) {
                console.error("Failed to load stored credentials:", e);
            }
        };
        loadStoredCredentials();
    }, []);

    const handleSaveGeminiKey = async () => {
        if (!apiKey.trim()) return;
        setApiKeySaving(true);
        try {
            // @ts-ignore
            const result = await window.electronAPI.setGeminiApiKey(apiKey);
            if (result.success) {
                setApiKeySaved(true);
                setHasStoredGeminiKey(true);
                setApiKey(''); // Clear the input after saving
                setTimeout(() => setApiKeySaved(false), 2000);
            }
        } catch (e) {
            console.error("Failed to save Gemini API key:", e);
        } finally {
            setApiKeySaving(false);
        }
    };

    const handleSaveGroqKey = async () => {
        if (!groqApiKey.trim()) return;
        setGroqKeySaving(true);
        try {
            // @ts-ignore
            const result = await window.electronAPI.setGroqApiKey(groqApiKey);
            if (result.success) {
                setGroqKeySaved(true);
                setHasStoredGroqKey(true);
                setGroqApiKey(''); // Clear the input after saving
                setTimeout(() => setGroqKeySaved(false), 2000);
            }
        } catch (e) {
            console.error("Failed to save Groq API key:", e);
        } finally {
            setGroqKeySaving(false);
        }
    };

    const handleSaveOpenaiKey = async () => {
        if (!openaiApiKey.trim()) return;
        setOpenaiKeySaving(true);
        try {
            // @ts-ignore
            const result = await window.electronAPI.setOpenaiApiKey(openaiApiKey);
            if (result.success) {
                setOpenaiKeySaved(true);
                setHasStoredOpenaiKey(true);
                setOpenaiApiKey(''); // Clear the input after saving
                setTimeout(() => setOpenaiKeySaved(false), 2000);
            }
        } catch (e) {
            console.error("Failed to save OpenAI API key:", e);
        } finally {
            setOpenaiKeySaving(false);
        }
    };

    const handleSaveClaudeKey = async () => {
        if (!claudeApiKey.trim()) return;
        setClaudeKeySaving(true);
        try {
            // @ts-ignore
            const result = await window.electronAPI.setClaudeApiKey(claudeApiKey);
            if (result.success) {
                setClaudeKeySaved(true);
                setHasStoredClaudeKey(true);
                setClaudeApiKey(''); // Clear the input after saving
                setTimeout(() => setClaudeKeySaved(false), 2000);
            }
        } catch (e) {
            console.error("Failed to save Claude API key:", e);
        } finally {
            setClaudeKeySaving(false);
        }
    };

    const handleSelectServiceAccount = async () => {
        try {
            const result = await window.electronAPI.selectServiceAccount();
            if (result.success && result.path) {
                setServiceAccountPath(result.path);
            }
        } catch (error) {
            console.error("Failed to select service account:", error);
        }
    };

    const handleCheckForUpdates = async () => {
        if (updateStatus === 'checking') return;
        setUpdateStatus('checking');
        try {
            await window.electronAPI.checkForUpdates();
        } catch (error) {
            console.error("Failed to check for updates:", error);
            setUpdateStatus('error');
            setTimeout(() => setUpdateStatus('idle'), 3000);
        }
    };

    useEffect(() => {
        if (!isOpen) return;

        const unsubs = [
            window.electronAPI.onUpdateChecking(() => {
                setUpdateStatus('checking');
            }),
            window.electronAPI.onUpdateAvailable(() => {
                setUpdateStatus('available');
                // Don't close settings - let user see the button change to "Update Available"
            }),
            window.electronAPI.onUpdateNotAvailable(() => {
                setUpdateStatus('uptodate');
                setTimeout(() => setUpdateStatus('idle'), 3000);
            }),
            window.electronAPI.onUpdateError((err) => {
                console.error('[Settings] Update error:', err);
                setUpdateStatus('error');
                setTimeout(() => setUpdateStatus('idle'), 3000);
            })
        ];

        return () => unsubs.forEach(unsub => unsub());
    }, [isOpen, onClose]);

    useEffect(() => {
        if (isOpen) {
            // Load detectable status
            if (window.electronAPI?.getUndetectable) {
                window.electronAPI.getUndetectable().then(setIsUndetectable);
            }
            if (window.electronAPI?.getOpenAtLogin) {
                window.electronAPI.getOpenAtLogin().then(setOpenOnLogin);
            }
            if (window.electronAPI?.getThemeMode) {
                window.electronAPI.getThemeMode().then(({ mode }) => setThemeMode(mode));
            }

            // Load settings
            const loadDevices = async () => {
                try {
                    const [inputs, outputs] = await Promise.all([
                        // @ts-ignore
                        window.electronAPI?.getInputDevices() || Promise.resolve([]),
                        // @ts-ignore
                        window.electronAPI?.getOutputDevices() || Promise.resolve([])
                    ]);

                    // Map to shape compatible with CustomSelect (which expects MediaDeviceInfo-like objects)
                    const formatDevices = (devs: any[]) => devs.map(d => ({
                        deviceId: d.id,
                        label: d.name,
                        kind: 'audioinput' as MediaDeviceKind,
                        groupId: '',
                        toJSON: () => d
                    }));

                    setInputDevices(formatDevices(inputs));
                    setOutputDevices(formatDevices(outputs));

                    // Load saved preferences
                    const savedInput = localStorage.getItem('preferredInputDeviceId');
                    const savedOutput = localStorage.getItem('preferredOutputDeviceId');

                    if (savedInput && inputs.find((d: any) => d.id === savedInput)) {
                        setSelectedInput(savedInput);
                    } else if (inputs.length > 0 && !selectedInput) {
                        setSelectedInput(inputs[0].id);
                    }

                    if (savedOutput && outputs.find((d: any) => d.id === savedOutput)) {
                        setSelectedOutput(savedOutput);
                    } else if (outputs.length > 0 && !selectedOutput) {
                        setSelectedOutput(outputs[0].id);
                    }
                } catch (e) {
                    console.error("Error loading native devices:", e);
                }
            };
            loadDevices();

            // Load Legacy Audio pref
            const savedLegacy = localStorage.getItem('useLegacyAudioBackend') === 'true';
            setUseLegacyAudio(savedLegacy);

            // Load Calendar Status
            if (window.electronAPI?.getCalendarStatus) {
                window.electronAPI.getCalendarStatus().then(setCalendarStatus);
            }
        }
    }, [isOpen, selectedInput, selectedOutput]); // Re-run if isOpen changes, or if selected devices are cleared

    // Effect for real-time audio level monitoring
    useEffect(() => {
        if (isOpen && activeTab === 'audio') {
            let mounted = true;

            const startAudio = async () => {
                try {
                    // Cleanup previous audio context if it exists
                    if (audioContextRef.current) {
                        audioContextRef.current.close();
                    }

                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: selectedInput ? { exact: selectedInput } : undefined
                        }
                    });

                    streamRef.current = stream;

                    if (!mounted) return;

                    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                    const analyser = audioContext.createAnalyser();
                    const source = audioContext.createMediaStreamSource(stream);

                    analyser.fftSize = 256;
                    source.connect(analyser);

                    audioContextRef.current = audioContext;
                    analyserRef.current = analyser;
                    sourceRef.current = source;

                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    let smoothLevel = 0;

                    const updateLevel = () => {
                        if (!mounted || !analyserRef.current) return;
                        // Use Time Domain Data for accurate volume (waveform) instead of frequency
                        analyserRef.current.getByteTimeDomainData(dataArray);

                        let sum = 0;
                        for (let i = 0; i < dataArray.length; i++) {
                            // Convert 0-255 to -1 to 1 range
                            const value = (dataArray[i] - 128) / 128;
                            sum += value * value;
                        }

                        // Calculate RMS
                        const rms = Math.sqrt(sum / dataArray.length);

                        // Convert to simpler 0-100 range with some boost
                        // RMS is usually very small (0.01 - 0.5 for normal speech)
                        // Logarithmic scaling feels more natural for volume
                        const db = 20 * Math.log10(rms);
                        // Approximate mapping: -60dB (silence) to 0dB (max) -> 0 to 100
                        const targetLevel = Math.max(0, Math.min(100, (db + 60) * 2));

                        // Apply smoothing
                        if (targetLevel > smoothLevel) {
                            smoothLevel = smoothLevel * 0.7 + targetLevel * 0.3; // Fast attack
                        } else {
                            smoothLevel = smoothLevel * 0.95 + targetLevel * 0.05; // Slow decay
                        }

                        setMicLevel(smoothLevel);

                        rafRef.current = requestAnimationFrame(updateLevel);
                    };

                    updateLevel();
                } catch (error) {
                    console.error("Error accessing microphone:", error);
                    setMicLevel(0); // Reset level on error
                }
            };

            startAudio();

            return () => {
                mounted = false;
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                if (sourceRef.current) sourceRef.current.disconnect();
                if (audioContextRef.current) {
                    audioContextRef.current.close();
                    audioContextRef.current = null;
                }
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
                setMicLevel(0); // Reset mic level on cleanup
            };
        } else {
            // Cleanup when closing tab or overlay or switching away from audio tab
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (sourceRef.current) sourceRef.current.disconnect(); // Disconnect source as well
            if (audioContextRef.current) {
                audioContextRef.current.close();
                audioContextRef.current = null;
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
            setMicLevel(0);
        }
    }, [isOpen, activeTab, selectedInput]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-8"
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0, y: 10 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.95, opacity: 0, y: 10 }}
                        transition={{ type: "spring", stiffness: 350, damping: 25 }}
                        className="bg-bg-elevated w-full max-w-4xl h-[80vh] rounded-2xl border border-border-subtle shadow-2xl flex overflow-hidden"
                    >
                        {/* Sidebar */}
                        <div className="w-64 bg-bg-sidebar flex flex-col border-r border-border-subtle">
                            <div className="p-6">
                                <h2 className="font-semibold text-gray-400 text-xs uppercase tracking-wider mb-4">Settings</h2>
                                <nav className="space-y-1">
                                    <button
                                        onClick={() => setActiveTab('general')}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === 'general' ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                    >
                                        <Monitor size={16} /> General
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('calendar')}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === 'calendar' ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                    >
                                        <Calendar size={16} /> Calendar
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('audio')}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === 'audio' ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                    >
                                        <Mic size={16} /> Audio
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('keybinds')}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === 'keybinds' ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                    >
                                        <Keyboard size={16} /> Keybinds
                                    </button>

                                    <button
                                        onClick={() => setActiveTab('about')}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-3 ${activeTab === 'about' ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50'}`}
                                    >
                                        <Info size={16} /> About
                                    </button>
                                </nav>
                            </div>

                            <div className="mt-auto p-6 border-t border-border-subtle">
                                <button
                                    onClick={() => window.electronAPI.quitApp()}
                                    className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-3"
                                >
                                    <LogOut size={16} /> Quit Natively
                                </button>
                                <button onClick={onClose} className="group mt-2 w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-bg-item-active/50 transition-colors flex items-center gap-3">
                                    <X size={18} className="group-hover:text-red-500 transition-colors" /> Close
                                </button>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto bg-bg-main p-8">
                            {activeTab === 'general' && (
                                <div className="space-y-8 animated fadeIn">
                                    <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle flex items-center justify-between">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex items-center gap-2">
                                                {isUndetectable ? (
                                                    <svg
                                                        width="18"
                                                        height="18"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        className="text-text-primary"
                                                    >
                                                        <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" fill="currentColor" stroke="currentColor" />
                                                        <path d="M9 10h.01" stroke="var(--bg-item-surface)" strokeWidth="2.5" />
                                                        <path d="M15 10h.01" stroke="var(--bg-item-surface)" strokeWidth="2.5" />
                                                    </svg>
                                                ) : (
                                                    <Ghost size={18} className="text-text-primary" />
                                                )}
                                                <h3 className="text-base font-bold text-text-primary">{isUndetectable ? 'Undetectable' : 'Detectable'}</h3>
                                            </div>
                                            <p className="text-xs text-text-secondary">
                                                Natively is currently {isUndetectable ? 'undetectable' : 'detectable'} by screen-sharing. <button className="text-blue-400 hover:underline">Supported apps here</button>
                                            </p>
                                        </div>
                                        <div
                                            onClick={() => {
                                                const newState = !isUndetectable;
                                                setIsUndetectable(newState);
                                                window.electronAPI?.setUndetectable(newState);
                                            }}
                                            className={`w-11 h-6 rounded-full relative cursor-pointer transition-colors ${isUndetectable ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                        >
                                            <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${isUndetectable ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </div>
                                    </div>

                                    <div className="pt-2">
                                        <h3 className="text-sm font-bold text-text-primary mb-1">General settings</h3>
                                        <p className="text-xs text-text-secondary mb-4">Customize how Natively works for you</p>

                                        <div className="space-y-4">
                                            {/* Open at Login */}
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                                        <Power size={20} />
                                                    </div>
                                                    <div>
                                                        <h3 className="text-sm font-bold text-text-primary">Open Natively when you log in</h3>
                                                        <p className="text-xs text-text-secondary mt-0.5">Natively will open automatically when you log in to your computer</p>
                                                    </div>
                                                </div>
                                                <div
                                                    onClick={() => {
                                                        const newState = !openOnLogin;
                                                        setOpenOnLogin(newState);
                                                        window.electronAPI?.setOpenAtLogin(newState);
                                                    }}
                                                    className={`w-11 h-6 rounded-full relative cursor-pointer transition-colors ${openOnLogin ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                                >
                                                    <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${openOnLogin ? 'translate-x-5' : 'translate-x-0'}`} />
                                                </div>
                                            </div>

                                            {/* Interviewer Transcript */}
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                                        <MessageSquare size={20} />
                                                    </div>
                                                    <div>
                                                        <h3 className="text-sm font-bold text-text-primary">Interviewer Transcript</h3>
                                                        <p className="text-xs text-text-secondary mt-0.5">Show real-time transcription of the interviewer</p>
                                                    </div>
                                                </div>
                                                <div
                                                    onClick={() => {
                                                        const newState = !showTranscript;
                                                        setShowTranscript(newState);
                                                        localStorage.setItem('natively_interviewer_transcript', String(newState));
                                                        window.dispatchEvent(new Event('storage'));
                                                    }}
                                                    className={`w-11 h-6 rounded-full relative cursor-pointer transition-colors ${showTranscript ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                                >
                                                    <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${showTranscript ? 'translate-x-5' : 'translate-x-0'}`} />
                                                </div>
                                            </div>


                                            {/* Theme */}
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                                                        <Palette size={20} />
                                                    </div>
                                                    <div>
                                                        <h3 className="text-sm font-bold text-text-primary">Theme</h3>
                                                        <p className="text-xs text-text-secondary mt-0.5">Customize how Natively looks on your device</p>
                                                    </div>
                                                </div>

                                                <div className="relative" ref={themeDropdownRef}>
                                                    <button
                                                        onClick={() => setIsThemeDropdownOpen(!isThemeDropdownOpen)}
                                                        className="bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 min-w-[100px] justify-between"
                                                    >
                                                        <div className="flex items-center gap-2 overflow-hidden">
                                                            <span className="text-text-secondary shrink-0">
                                                                {themeMode === 'system' && <Monitor size={14} />}
                                                                {themeMode === 'light' && <Sun size={14} />}
                                                                {themeMode === 'dark' && <Moon size={14} />}
                                                            </span>
                                                            <span className="capitalize text-ellipsis overflow-hidden whitespace-nowrap">{themeMode}</span>
                                                        </div>
                                                        <ChevronDown size={12} className={`shrink-0 transition-transform ${isThemeDropdownOpen ? 'rotate-180' : ''}`} />
                                                    </button>

                                                    {/* Dropdown Menu */}
                                                    {isThemeDropdownOpen && (
                                                        <div className="absolute right-0 top-full mt-1 w-full bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden z-20 p-1 animated fadeIn select-none">
                                                            {[
                                                                { mode: 'system', label: 'System', icon: <Monitor size={14} /> },
                                                                { mode: 'light', label: 'Light', icon: <Sun size={14} /> },
                                                                { mode: 'dark', label: 'Dark', icon: <Moon size={14} /> }
                                                            ].map((option) => (
                                                                <button
                                                                    key={option.mode}
                                                                    onClick={() => {
                                                                        handleSetTheme(option.mode as any);
                                                                        setIsThemeDropdownOpen(false);
                                                                    }}
                                                                    className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors ${themeMode === option.mode ? 'text-text-primary bg-bg-item-active/50' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                                                >
                                                                    <span className={themeMode === option.mode ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}>{option.icon}</span>
                                                                    <span className="font-medium">{option.label}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Version */}
                                            <div className="flex items-start justify-between gap-4">
                                                <div className="flex items-start gap-4">
                                                    <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
                                                        <BadgeCheck size={20} />
                                                    </div>
                                                    <div>
                                                        <h3 className="text-sm font-bold text-text-primary">Version</h3>
                                                        <p className="text-xs text-text-secondary mt-0.5">
                                                            You are currently using Natively version 1.0.1.
                                                        </p>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={async () => {
                                                        if (updateStatus === 'available') {
                                                            try {
                                                                // @ts-ignore
                                                                await window.electronAPI.downloadUpdate();
                                                                onClose(); // Close settings to show the banner
                                                            } catch (err) {
                                                                console.error("Failed to start download:", err);
                                                            }
                                                        } else {
                                                            handleCheckForUpdates();
                                                        }
                                                    }}
                                                    disabled={updateStatus === 'checking'}
                                                    className={`px-5 py-2 rounded-lg text-[13px] font-bold transition-all flex items-center gap-2 shrink-0 ${updateStatus === 'checking' ? 'bg-bg-input text-text-tertiary cursor-wait' :
                                                        updateStatus === 'available' ? 'bg-accent-primary text-white hover:bg-accent-secondary shadow-lg shadow-blue-500/20' :
                                                            updateStatus === 'uptodate' ? 'bg-green-500/10 text-green-400 border border-green-500/20' :
                                                                updateStatus === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                                                                    'bg-bg-component hover:bg-bg-input text-text-primary'
                                                        }`}
                                                >
                                                    {updateStatus === 'checking' ? (
                                                        <>
                                                            <RefreshCw size={14} className="animate-spin" />
                                                            Checking...
                                                        </>
                                                    ) : updateStatus === 'available' ? (
                                                        <>
                                                            <ArrowDown size={14} />
                                                            Update Available
                                                        </>
                                                    ) : updateStatus === 'uptodate' ? (
                                                        <>
                                                            <Check size={14} />
                                                            Up to date
                                                        </>
                                                    ) : updateStatus === 'error' ? (
                                                        <>
                                                            <X size={14} />
                                                            Error
                                                        </>
                                                    ) : (
                                                        <>
                                                            <RefreshCw size={14} />
                                                            Check for updates
                                                        </>
                                                    )}
                                                </button>
                                            </div>

                                        </div>
                                    </div>

                                    <div className="h-px bg-border-subtle" />

                                    <div>
                                        <h3 className="text-sm font-bold text-text-primary mb-4">Advanced API</h3>
                                        <div className="space-y-4">
                                            <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                                                <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                                                    Gemini API Key
                                                    {hasStoredGeminiKey && <span className="ml-2 text-green-500 normal-case">✓ Saved</span>}
                                                </label>
                                                <div className="flex gap-3">
                                                    <input
                                                        type="password"
                                                        value={apiKey}
                                                        onChange={(e) => setApiKey(e.target.value)}
                                                        placeholder={hasStoredGeminiKey ? "••••••••••••" : "AIzaSy..."}
                                                        className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                                                    />
                                                    <button
                                                        onClick={handleSaveGeminiKey}
                                                        disabled={apiKeySaving || !apiKey.trim()}
                                                        className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${apiKeySaved
                                                            ? 'bg-green-500/20 text-green-400'
                                                            : 'bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary disabled:opacity-50'
                                                            }`}
                                                    >
                                                        {apiKeySaving ? 'Saving...' : apiKeySaved ? 'Saved!' : 'Save'}
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                                                <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                                                    Groq API Key
                                                    {hasStoredGroqKey && <span className="ml-2 text-green-500 normal-case">✓ Saved</span>}
                                                </label>
                                                <div className="flex gap-3">
                                                    <input
                                                        type="password"
                                                        value={groqApiKey}
                                                        onChange={(e) => setGroqApiKey(e.target.value)}
                                                        placeholder={hasStoredGroqKey ? "••••••••••••" : "gsk_..."}
                                                        className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                                                    />
                                                    <button
                                                        onClick={handleSaveGroqKey}
                                                        disabled={groqKeySaving || !groqApiKey.trim()}
                                                        className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${groqKeySaved
                                                            ? 'bg-green-500/20 text-green-400'
                                                            : 'bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary disabled:opacity-50'
                                                            }`}
                                                    >
                                                        {groqKeySaving ? 'Saving...' : groqKeySaved ? 'Saved!' : 'Save'}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-text-tertiary mt-2">Used for fast text-only responses (optional)</p>
                                            </div>

                                            <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                                                <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                                                    OpenAI API Key
                                                    {hasStoredOpenaiKey && <span className="ml-2 text-green-500 normal-case">✓ Saved</span>}
                                                </label>
                                                <div className="flex gap-3">
                                                    <input
                                                        type="password"
                                                        value={openaiApiKey}
                                                        onChange={(e) => setOpenaiApiKey(e.target.value)}
                                                        placeholder={hasStoredOpenaiKey ? "••••••••••••" : "sk-..."}
                                                        className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                                                    />
                                                    <button
                                                        onClick={handleSaveOpenaiKey}
                                                        disabled={openaiKeySaving || !openaiApiKey.trim()}
                                                        className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${openaiKeySaved
                                                            ? 'bg-green-500/20 text-green-400'
                                                            : 'bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary disabled:opacity-50'
                                                            }`}
                                                    >
                                                        {openaiKeySaving ? 'Saving...' : openaiKeySaved ? 'Saved!' : 'Save'}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-text-tertiary mt-2">Used for GPT-4o text and vision responses (optional)</p>
                                            </div>

                                            <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                                                <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                                                    Claude API Key
                                                    {hasStoredClaudeKey && <span className="ml-2 text-green-500 normal-case">✓ Saved</span>}
                                                </label>
                                                <div className="flex gap-3">
                                                    <input
                                                        type="password"
                                                        value={claudeApiKey}
                                                        onChange={(e) => setClaudeApiKey(e.target.value)}
                                                        placeholder={hasStoredClaudeKey ? "••••••••••••" : "sk-ant-..."}
                                                        className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors"
                                                    />
                                                    <button
                                                        onClick={handleSaveClaudeKey}
                                                        disabled={claudeKeySaving || !claudeApiKey.trim()}
                                                        className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${claudeKeySaved
                                                            ? 'bg-green-500/20 text-green-400'
                                                            : 'bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary disabled:opacity-50'
                                                            }`}
                                                    >
                                                        {claudeKeySaving ? 'Saving...' : claudeKeySaved ? 'Saved!' : 'Save'}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-text-tertiary mt-2">Used for Claude text and vision responses (optional)</p>
                                            </div>
                                            <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                                                <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Google Cloud Service Account JSON</label>
                                                <div className="flex gap-3">
                                                    <div className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-secondary truncate flex items-center">
                                                        {serviceAccountPath || "No file selected"}
                                                    </div>
                                                    <button
                                                        onClick={handleSelectServiceAccount}
                                                        className="bg-bg-input hover:bg-bg-secondary border border-border-subtle text-text-primary px-5 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
                                                    >
                                                        Select File
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {activeTab === 'keybinds' && (
                                <div className="space-y-5 animated fadeIn select-text h-full flex flex-col justify-center">
                                    <div>
                                        <h3 className="text-base font-bold text-text-primary mb-1">Keyboard shortcuts</h3>
                                        <p className="text-xs text-text-secondary">Natively works with these easy to remember commands.</p>
                                    </div>

                                    <div className="grid gap-6">
                                        {/* General Category */}
                                        <div>
                                            <h4 className="text-sm font-bold text-text-primary mb-3">General</h4>
                                            <div className="space-y-1">
                                                {[
                                                    { label: 'Toggle Visibility', keys: ['⌘', 'B'], icon: <Eye size={14} /> },
                                                    { label: 'Show/Center Natively', keys: ['⌘', '⇧', 'Space'], icon: <Layout size={14} /> },
                                                    { label: 'Process Screenshots', keys: ['⌘', 'Enter'], icon: <MessageSquare size={14} /> },
                                                    { label: 'Reset / Cancel', keys: ['⌘', 'R'], icon: <RotateCcw size={14} /> },
                                                    { label: 'Take Screenshot', keys: ['⌘', 'H'], icon: <Camera size={14} /> },
                                                    { label: 'Selective Screenshot', keys: ['⌘', '⇧', 'H'], icon: <Crop size={14} /> },
                                                ].map((item, i) => (
                                                    <div key={i} className="flex items-center justify-between py-1.5 group">
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-text-tertiary group-hover:text-text-primary transition-colors">{item.icon}</span>
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">{item.label}</span>
                                                        </div>
                                                        <div className="flex items-center gap-1.5">
                                                            {item.keys.map((k, j) => (
                                                                <span key={j} className="bg-bg-input text-text-secondary px-2 py-1 rounded-md text-xs font-sans min-w-[24px] text-center shadow-sm border border-border-subtle">
                                                                    {k}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Window Category */}
                                        <div>
                                            <h4 className="text-sm font-bold text-white mb-3">Window</h4>
                                            <div className="space-y-1">
                                                {[
                                                    { label: 'Move Window Up', keys: ['⌘', '↑'], icon: <ArrowUp size={14} /> },
                                                    { label: 'Move Window Down', keys: ['⌘', '↓'], icon: <ArrowDown size={14} /> },
                                                    { label: 'Move Window Left', keys: ['⌘', '←'], icon: <ArrowLeft size={14} /> },
                                                    { label: 'Move Window Right', keys: ['⌘', '→'], icon: <ArrowRight size={14} /> }
                                                ].map((item, i) => (
                                                    <div key={i} className="flex items-center justify-between py-1.5 group">
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-text-tertiary group-hover:text-text-primary transition-colors">{item.icon}</span>
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">{item.label}</span>
                                                        </div>
                                                        <div className="flex items-center gap-1.5">
                                                            {item.keys.map((k, j) => (
                                                                <span key={j} className="bg-bg-input text-text-secondary px-2 py-1 rounded-md text-xs font-sans min-w-[24px] text-center shadow-sm border border-border-subtle">
                                                                    {k}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'audio' && (
                                <div className="space-y-6 animated fadeIn">
                                    <div>
                                        <h3 className="text-lg font-medium text-text-primary mb-6">Audio Configuration</h3>

                                        <div className="space-y-6">
                                            {/* Speech Recognition Section */}
                                            <div>
                                                <CustomSelect
                                                    label="Preferred English Accent"
                                                    icon={null}
                                                    value={recognitionLanguage}
                                                    options={languageOptions}
                                                    onChange={handleLanguageChange}
                                                    placeholder="Select Accent"
                                                />

                                                <div className="flex gap-2 items-center mt-2 px-1">
                                                    <Info size={14} className="text-text-secondary shrink-0" />
                                                    <p className="text-xs text-text-secondary whitespace-nowrap">
                                                        Improves accuracy by prioritizing your accent. Other English accents are still supported.
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="h-px bg-border-subtle" />

                                            <div className="space-y-4">
                                                <CustomSelect
                                                    label="Input Device"
                                                    icon={<Mic size={16} />}
                                                    value={selectedInput}
                                                    options={inputDevices}
                                                    onChange={(id) => {
                                                        setSelectedInput(id);
                                                        localStorage.setItem('preferredInputDeviceId', id);
                                                    }}
                                                    placeholder="Default Microphone"
                                                />

                                                <div>
                                                    <div className="flex justify-between text-xs text-text-secondary mb-2 px-1">
                                                        <span>Input Level</span>
                                                    </div>
                                                    <div className="h-1.5 bg-bg-input rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-green-500 transition-all duration-100 ease-out"
                                                            style={{ width: `${micLevel}%` }}
                                                        />
                                                    </div>
                                                </div>

                                                <div className="h-px bg-border-subtle my-4" />

                                                <CustomSelect
                                                    label="Output Device"
                                                    icon={<Speaker size={16} />}
                                                    value={selectedOutput}
                                                    options={outputDevices}
                                                    onChange={(id) => {
                                                        setSelectedOutput(id);
                                                        localStorage.setItem('preferredOutputDeviceId', id);
                                                    }}
                                                    placeholder="Default Speakers"
                                                />

                                                <div className="flex justify-end">
                                                    <button
                                                        onClick={() => {
                                                            const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3'); // Simple test sound
                                                            // Try to set sinkId if supported
                                                            if (selectedOutput && (audio as any).setSinkId) {
                                                                (audio as any).setSinkId(selectedOutput)
                                                                    .catch((e: any) => console.error("Error setting sink", e));
                                                            }
                                                            audio.play().catch(e => console.error("Error playing test sound", e));
                                                        }}
                                                        className="text-xs bg-bg-input hover:bg-bg-elevated text-text-primary px-3 py-1.5 rounded-md transition-colors flex items-center gap-2"
                                                    >
                                                        <Speaker size={12} /> Test Sound
                                                    </button>
                                                </div>

                                                <div className="h-px bg-border-subtle my-4" />

                                                {/* Experimental ScreenCaptureKit Toggle */}
                                                {/* Experimental ScreenCaptureKit Toggle */}
                                                <div className="bg-amber-500/5 rounded-xl border border-amber-500/20 p-4">
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-start gap-3">
                                                            <div className="mt-0.5 p-1.5 rounded-lg bg-amber-500/10 text-amber-500">
                                                                <FlaskConical size={18} />
                                                            </div>
                                                            <div>
                                                                <div className="flex items-center gap-2 mb-0.5">
                                                                    <h3 className="text-sm font-bold text-text-primary">CoreAudio Backend</h3>
                                                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-600 uppercase tracking-wide">Beta</span>
                                                                </div>
                                                                <p className="text-xs text-text-secondary leading-relaxed max-w-[300px]">
                                                                    Legacy audio capture method. Use only if you experience issues with the default engine.
                                                                </p>
                                                            </div>
                                                        </div>
                                                        <div
                                                            onClick={() => {
                                                                const newState = !useLegacyAudio;
                                                                setUseLegacyAudio(newState);
                                                                window.localStorage.setItem('useLegacyAudioBackend', newState ? 'true' : 'false');
                                                            }}
                                                            className={`w-11 h-6 rounded-full relative cursor-pointer transition-colors shrink-0 ${useLegacyAudio ? 'bg-amber-500' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                                        >
                                                            <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${useLegacyAudio ? 'translate-x-5' : 'translate-x-0'}`} />
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}


                            {activeTab === 'calendar' && (
                                <div className="space-y-6 animated fadeIn h-full">
                                    <div>
                                        <h3 className="text-base font-bold text-text-primary mb-1">Visible Calendars</h3>
                                        <p className="text-sm text-text-secondary">Upcoming meetings are synchronized from these calendars</p>
                                    </div>

                                    <div className="bg-bg-card rounded-xl p-6 border border-border-subtle flex flex-col items-start gap-4">
                                        {calendarStatus.connected ? (
                                            <div className="w-full flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-500">
                                                        <Calendar size={20} />
                                                    </div>
                                                    <div>
                                                        <h4 className="text-sm font-medium text-text-primary">Google Calendar</h4>
                                                        <p className="text-xs text-text-secondary">Connected as {calendarStatus.email || 'User'}</p>
                                                    </div>
                                                </div>

                                                <button
                                                    onClick={async () => {
                                                        setIsCalendarsLoading(true);
                                                        try {
                                                            await window.electronAPI.calendarDisconnect();
                                                            const status = await window.electronAPI.getCalendarStatus();
                                                            setCalendarStatus(status);
                                                        } catch (e) {
                                                            console.error(e);
                                                        } finally {
                                                            setIsCalendarsLoading(false);
                                                        }
                                                    }}
                                                    disabled={isCalendarsLoading}
                                                    className="px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-xs font-medium transition-colors"
                                                >
                                                    {isCalendarsLoading ? 'Disconnecting...' : 'Disconnect'}
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="w-full py-4">
                                                <div className="mb-4">
                                                    <Calendar size={24} className="text-text-tertiary mb-3" />
                                                    <h4 className="text-sm font-bold text-text-primary mb-1">No calendars</h4>
                                                    <p className="text-xs text-text-secondary">Get started by connecting a Google account.</p>
                                                </div>

                                                <button
                                                    onClick={async () => {
                                                        setIsCalendarsLoading(true);
                                                        try {
                                                            const res = await window.electronAPI.calendarConnect();
                                                            if (res.success) {
                                                                const status = await window.electronAPI.getCalendarStatus();
                                                                setCalendarStatus(status);
                                                            }
                                                        } catch (e) {
                                                            console.error(e);
                                                        } finally {
                                                            setIsCalendarsLoading(false);
                                                        }
                                                    }}
                                                    disabled={isCalendarsLoading}
                                                    className="bg-[#303033] hover:bg-[#3A3A3D] text-white px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-2.5"
                                                >
                                                    <svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
                                                        <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
                                                            <path fill="#4285F4" d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.749 L -8.284 53.749 C -8.574 55.229 -9.424 56.479 -10.684 57.329 L -10.684 60.329 L -6.824 60.329 C -4.564 58.239 -3.264 55.159 -3.264 51.509 Z" />
                                                            <path fill="#34A853" d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.329 C -11.764 58.049 -13.134 58.489 -14.754 58.489 C -17.884 58.489 -20.534 56.379 -21.484 53.529 L -25.464 53.529 L -25.464 56.619 C -23.494 60.539 -19.444 63.239 -14.754 63.239 Z" />
                                                            <path fill="#FBBC05" d="M -21.484 53.529 C -21.734 52.809 -21.864 52.039 -21.864 51.239 C -21.864 50.439 -21.734 49.669 -21.484 48.949 L -21.484 45.859 L -25.464 45.859 C -26.284 47.479 -26.754 49.299 -26.754 51.239 C -26.754 53.179 -26.284 54.999 -25.464 56.619 L -21.484 53.529 Z" />
                                                            <path fill="#EA4335" d="M -14.754 43.989 C -12.984 43.989 -11.404 44.599 -10.154 45.789 L -6.734 42.369 C -8.804 40.429 -11.514 39.239 -14.754 39.239 C -19.444 39.239 -23.494 41.939 -25.464 45.859 L -21.484 48.949 C -20.534 46.099 -17.884 43.989 -14.754 43.989 Z" />
                                                        </g>
                                                    </svg>
                                                    {isCalendarsLoading ? 'Connecting...' : 'Connect Google'}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {activeTab === 'about' && (
                                <AboutSection />
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default SettingsOverlay;
