import React, { useState, useEffect } from 'react';
import {
    Github, Twitter, Info, Shield, Cpu, Zap, Database,
    RefreshCw, ExternalLink, Heart, Server, Globe, Key, Linkedin, Instagram, Mail, MicOff, Star, Bug
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
        <div className="space-y-6 animated fadeIn pb-10">
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
                        <MicOff size={16} className="text-red-500 mt-0.5" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">No Recording</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                Natively listens only when active. It does not record video, take arbitrary screenshots without command, or perform background surveillance.
                            </p>
                        </div>
                    </div>
                </div>
            </div>





            {/* Community Section */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-4 px-1">Community</h4>
                <div className="space-y-4">
                    {/* 1. Founder Profile */}
                    <div className="bg-bg-item-surface rounded-xl p-5">
                        <div className="flex flex-col gap-4">
                            <div className="flex items-start gap-4">
                                <div className="w-12 h-12 rounded-full bg-bg-elevated border border-border-subtle flex items-center justify-center overflow-hidden shrink-0">
                                    <img src={evinProfile} alt="Evin John" className="w-full h-full object-cover" />
                                </div>
                                <div className="pt-0.5">
                                    <div className="flex items-center gap-2 mb-1">
                                        <h5 className="text-sm font-bold text-text-primary">Evin John</h5>
                                        <span className="text-[10px] font-medium px-1.5 py-[1px] rounded-full bg-yellow-400/10 text-yellow-200 border border-yellow-400/5">Creator</span>
                                    </div>
                                    <p className="text-xs text-text-secondary leading-relaxed max-w-lg">
                                        I build software that stays out of the way.
                                        <br />
                                        <span className="font-bold text-text-primary">Natively</span> is made to feel fast, quiet, and respectful of your privacy.
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 pl-[60px]">
                                <a
                                    href="https://github.com/evinjohnn/natively-cluely-ai-assistant"
                                    onClick={(e) => handleOpenLink(e, "https://github.com/evinjohnn/natively-cluely-ai-assistant")}
                                    className="text-text-tertiary hover:text-text-primary transition-colors"
                                    title="GitHub"
                                >
                                    <Github size={18} />
                                </a>
                                <a
                                    href="https://x.com/evinjohnn"
                                    onClick={(e) => handleOpenLink(e, "https://x.com/evinjohnn")}
                                    className="text-text-tertiary hover:text-text-primary transition-colors"
                                    title="Twitter"
                                >
                                    <Twitter size={18} />
                                </a>
                                <a
                                    href="https://www.linkedin.com/in/evinjohn"
                                    onClick={(e) => handleOpenLink(e, "https://www.linkedin.com/in/evinjohn")}
                                    className="text-text-tertiary hover:text-text-primary transition-colors"
                                    title="LinkedIn"
                                >
                                    <Linkedin size={18} />
                                </a>
                                <a
                                    href="https://www.instagram.com/evinjohnn/"
                                    onClick={(e) => handleOpenLink(e, "https://www.instagram.com/evinjohnn/")}
                                    className="text-text-tertiary hover:text-text-primary transition-colors"
                                    title="Instagram"
                                >
                                    <Instagram size={18} />
                                </a>
                            </div>
                        </div>
                    </div>

                    {/* 2. Star & Report */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <a
                            href="https://github.com/evinjohnn/natively-cluely-ai-assistant"
                            onClick={(e) => handleOpenLink(e, "https://github.com/evinjohnn/natively-cluely-ai-assistant")}
                            className="bg-bg-item-surface border border-border-subtle rounded-xl p-5 transition-all group flex items-center gap-4 cursor-pointer h-full hover:bg-white/10"
                        >
                            <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center text-yellow-500 shrink-0 group-hover:scale-110 transition-transform">
                                <Star size={20} className="transition-all group-hover:fill-current" />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary">Star on GitHub</h5>
                                <p className="text-xs text-text-secondary mt-0.5">Love Natively? Support us by starring the repo.</p>
                            </div>
                        </a>

                        <a
                            href="https://github.com/evinjohnn/natively-cluely-ai-assistant/issues"
                            onClick={(e) => handleOpenLink(e, "https://github.com/evinjohnn/natively-cluely-ai-assistant/issues")}
                            className="bg-bg-item-surface border border-border-subtle rounded-xl p-5 transition-all group flex items-center gap-4 cursor-pointer h-full hover:bg-white/10"
                        >
                            <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center text-red-500 shrink-0 group-hover:scale-110 transition-transform">
                                <Bug size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary">Report an Issue</h5>
                                <p className="text-xs text-text-secondary mt-0.5">Found a bug? Let us know so we can fix it.</p>
                            </div>
                        </a>
                    </div>

                    {/* 3. Get in Touch */}
                    <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500 shadow-sm shadow-blue-500/5">
                                <Mail size={18} className="opacity-80" />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary">Get in Touch</h5>
                                <p className="text-xs text-text-secondary mt-0.5">Open for professional collaborations and job offers.</p>
                            </div>
                        </div>
                        <a
                            href="mailto:evinjohnignatious@gmail.com"
                            onClick={(e) => handleOpenLink(e, "mailto:evinjohnignatious@gmail.com")}
                            className="whitespace-nowrap px-4 py-2 bg-text-primary hover:bg-white/90 text-bg-main text-xs font-bold rounded-lg transition-all shadow hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 flex items-center gap-2"
                        >
                            <Mail size={14} />
                            Contact Me
                        </a>
                    </div>

                    {/* 4. Support */}
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
                            href="https://buymeacoffee.com/evinjohnn"
                            onClick={(e) => handleOpenLink(e, "https://buymeacoffee.com/evinjohnn")}
                            className="whitespace-nowrap px-4 py-2 bg-text-primary hover:bg-white/90 text-bg-main text-xs font-bold rounded-lg transition-all shadow hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0"
                        >
                            Support Project
                        </a>
                    </div>
                </div>
            </div>

            {/* Credits */}
            <div className="pt-4 border-t border-border-subtle">
                <div>
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-3">Core Technology</h4>
                    <div className="flex flex-wrap gap-2">
                        {['Groq', 'Google Gemini', 'Google Speech-to-Text', 'Electron', 'React', 'Rust', 'Cpal'].map(tech => (
                            <span key={tech} className="px-2.5 py-1 rounded-md bg-bg-input border border-border-subtle text-[11px] font-medium text-text-secondary">
                                {tech}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div >
    );
};
