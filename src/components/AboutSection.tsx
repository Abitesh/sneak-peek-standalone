import React, { useState, useEffect } from 'react';
import {
    Github, Twitter, Info, Shield, Cpu, Zap, Database,
    RefreshCw, ExternalLink, Heart, Server, Globe, Key, Linkedin, Instagram
} from 'lucide-react';
import evinProfile from '../assets/evin.png';

interface AboutSectionProps { }

export const AboutSection: React.FC<AboutSectionProps> = () => {
    const handleOpenLink = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
        e.preventDefault();
        // Use backend shell.openExternal to ensure it opens in default browser
        if (window.electronAPI?.invoke) {
            window.electronAPI.invoke('open-external', url);
        } else {
            window.open(url, '_blank');
        }
    };

    return (
        <div className="space-y-8 animated fadeIn pb-10">
            {/* Header */}
            <div>
                <h3 className="text-xl font-bold text-text-primary mb-1">About Natively</h3>
                <p className="text-sm text-text-secondary">Designed to be invisible, intelligent, and trusted.</p>
            </div>

            {/* Architecture Section */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-4 px-1">How Natively Works</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">
                    <div className="p-5 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                                <Cpu size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Hybrid Intelligence</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Natively routes queries between <span className="text-text-primary font-medium">Groq</span> for near-instant responses and <span className="text-text-primary font-medium">Google Gemini</span> for complex reasoning. Audio is processed via Google Speech-to-Text for enterprise-grade accuracy.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-5 bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                <Database size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Context Awareness (RAG)</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    A local vector memory system allows Natively to recall details from your past interactions. Context retrieval happens securely on-device where possible to minimize latency.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Privacy Section */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-4 px-1">Privacy & Data</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 space-y-4">
                    <div className="flex items-start gap-3">
                        <Shield size={16} className="text-green-400 mt-0.5" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">Controlled Data Flow</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                Audio and text are transmitted only to processed endpoints (Google Cloud, Groq) and are not stored permanently by Natively's servers.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <Server size={16} className="text-text-tertiary mt-0.5" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">No Recording</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                Natively listens only when active. It does not record video, take arbitrary screenshots without command, or perform background surveillance.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Maintainer */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-4 px-1">Maintainer</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 flex items-center gap-5">
                    <div className="w-14 h-14 rounded-full bg-bg-elevated border border-border-subtle flex items-center justify-center text-text-tertiary shadow-sm overflow-hidden">
                        <img src={evinProfile} alt="Evin" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1">
                        <h5 className="text-base font-bold text-text-primary">Evin</h5>
                        <p className="text-xs text-text-secondary mb-3">Creator & Lead Engineer</p>
                        <div className="flex flex-wrap items-center gap-3">
                            <a
                                href="https://github.com/evinjohnn/natively-cluely-ai-assistant"
                                onClick={(e) => handleOpenLink(e, "https://github.com/evinjohnn/natively-cluely-ai-assistant")}
                                className="text-xs flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors bg-bg-input px-2.5 py-1.5 rounded-md border border-border-subtle hover:bg-bg-elevated"
                            >
                                <Github size={12} /> GitHub
                            </a>
                            <a
                                href="https://x.com/evinjohnn"
                                onClick={(e) => handleOpenLink(e, "https://x.com/evinjohnn")}
                                className="text-xs flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors bg-bg-input px-2.5 py-1.5 rounded-md border border-border-subtle hover:bg-bg-elevated"
                            >
                                <Twitter size={12} /> Twitter
                            </a>
                            <a
                                href="https://www.linkedin.com/in/evinjohn"
                                onClick={(e) => handleOpenLink(e, "https://www.linkedin.com/in/evinjohn")}
                                className="text-xs flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors bg-bg-input px-2.5 py-1.5 rounded-md border border-border-subtle hover:bg-bg-elevated"
                            >
                                <Linkedin size={12} /> LinkedIn
                            </a>
                            <a
                                href="https://www.instagram.com/evinjohnn/"
                                onClick={(e) => handleOpenLink(e, "https://www.instagram.com/evinjohnn/")}
                                className="text-xs flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors bg-bg-input px-2.5 py-1.5 rounded-md border border-border-subtle hover:bg-bg-elevated"
                            >
                                <Instagram size={12} /> Instagram
                            </a>
                        </div>
                    </div>
                </div>
            </div>

            {/* Support */}
            <div>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-pink-500/10 flex items-center justify-center text-pink-500 shadow-sm shadow-pink-500/5">
                            <Heart size={18} fill="currentColor" className="opacity-80" />
                        </div>
                        <div>
                            <h5 className="text-sm font-bold text-text-primary">Support Development</h5>
                            <p className="text-xs text-text-secondary mt-0.5">Natively is independent open-source software.</p>
                        </div>
                    </div>
                    <a
                        href="https://ko-fi.com/evinjohnn"
                        onClick={(e) => handleOpenLink(e, "https://ko-fi.com/evinjohnn")}
                        className="whitespace-nowrap px-4 py-2 bg-text-primary hover:bg-white/90 text-bg-main text-xs font-bold rounded-lg transition-all shadow hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0"
                    >
                        Support Project
                    </a>
                </div>
            </div>

            {/* Credits */}
            <div className="pt-4 border-t border-border-subtle">
                <div>
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-3">Core Technology</h4>
                    <div className="flex flex-wrap gap-2">
                        {['Groq', 'Google Gemini', 'Google Speech-to-Text', 'Tauri', 'React', 'Rust'].map(tech => (
                            <span key={tech} className="px-2.5 py-1 rounded-md bg-bg-input border border-border-subtle text-[11px] font-medium text-text-secondary">
                                {tech}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
