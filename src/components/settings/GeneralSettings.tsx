import React, { useState, useEffect } from 'react';
import { Info, Monitor, Globe } from 'lucide-react';

interface GeneralSettingsProps { }

export const GeneralSettings: React.FC<GeneralSettingsProps> = () => {
    // Recognition Language
    const [recognitionLanguage, setRecognitionLanguage] = useState('');
    const [availableLanguages, setAvailableLanguages] = useState<Record<string, any>>({});
    const [languageOptions, setLanguageOptions] = useState<any[]>([]);

    // Google Service Account
    const [serviceAccountPath, setServiceAccountPath] = useState('');

    useEffect(() => {
        const loadInitialData = async () => {
            // Load Credentials
            try {
                // @ts-ignore  
                const creds = await window.electronAPI?.getStoredCredentials?.();
                if (creds && creds.googleServiceAccountPath) {
                    setServiceAccountPath(creds.googleServiceAccountPath);
                }
            } catch (e) {
                console.error("Failed to load stored credentials:", e);
            }

            // Load Languages
            if (window.electronAPI?.getRecognitionLanguages) {
                const langs = await window.electronAPI.getRecognitionLanguages();
                setAvailableLanguages(langs);

                const desiredOrder = [
                    { key: 'english-india', label: 'English (India)' },
                    { key: 'english-us', label: 'English (United States)' },
                    { key: 'english-uk', label: 'English (United Kingdom)' },
                    { key: 'english-au', label: 'English (Australia)' },
                    { key: 'english-ca', label: 'English (Canada)' },
                ];

                const options = [
                    { value: 'auto', label: 'Auto (Recommended)' }
                ];

                desiredOrder.forEach(({ key, label }) => {
                    if (langs[key]) {
                        options.push({ value: key, label: label });
                    }
                });

                setLanguageOptions(options);

                const stored = localStorage.getItem('natively_recognition_language');
                if (!stored || stored === 'auto') {
                    setRecognitionLanguage('auto');
                    applyAutoLanguage(langs);
                } else if (langs[stored]) {
                    setRecognitionLanguage(stored);
                } else {
                    setRecognitionLanguage('auto');
                    applyAutoLanguage(langs);
                }
            }
        };
        loadInitialData();
    }, []);

    const applyAutoLanguage = (langs: any) => {
        const systemLocale = navigator.language;
        let match = 'english-us';
        for (const [key, config] of Object.entries(langs)) {
            if ((config as any).primary === systemLocale || (config as any).alternates.includes(systemLocale)) {
                match = key;
                break;
            }
        }
        if (systemLocale === 'en-IN') match = 'english-india';

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

    return (
        <div className="space-y-8 animated fadeIn">
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-2">General Configuration</h3>
                <p className="text-xs text-text-secondary mb-4">Core settings for Natively.</p>

                <div className="space-y-4">
                    {/* Google Cloud Service Account */}
                    <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                        <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Google Speech-to-Text Key (JSON)</label>
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
                        <p className="text-xs text-text-tertiary mt-2">Required for accurate speech recognition.</p>
                    </div>

                    {/* Recognition Language */}
                    <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
                        <label className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">Recognition Language</label>
                        <div className="relative">
                            <select
                                value={recognitionLanguage}
                                onChange={(e) => handleLanguageChange(e.target.value)}
                                className="w-full appearance-none bg-bg-input border border-border-subtle rounded-lg px-4 py-2.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary transition-colors cursor-pointer"
                            >
                                {languageOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                            <Globe size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
                        </div>
                        <p className="text-xs text-text-tertiary mt-2">Select your preferred accent for better recognition accuracy.</p>
                    </div>
                </div>
            </div>
        </div>
    );
};
