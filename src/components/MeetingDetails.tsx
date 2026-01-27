import React, { useState } from 'react';
import { ArrowLeft, Search, Mail, Link, ChevronDown, Play, ArrowUp, Copy, Check, MoreHorizontal, Settings, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
};

const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
};

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
}

interface MeetingDetailsProps {
    meeting: Meeting;
    onBack: () => void;
    onOpenSettings: () => void;
}

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting, onBack, onOpenSettings }) => {
    const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'usage'>('summary');
    const [query, setQuery] = useState('');

    return (
        <div className="h-full w-full flex flex-col bg-[#0C0C0D] text-[#A4A4A7] font-sans overflow-hidden">
            {/* Main Content */}
            <main className="flex-1 overflow-y-auto custom-scrollbar">
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    className="max-w-4xl mx-auto px-8 py-8 pb-32" // Added pb-32 for floating footer clearance
                >
                    {/* Meta Info & Actions Row */}
                    <div className="flex items-start justify-between mb-6">
                        <div>
                            {/* Date formatting could be improved to use meeting.date if it's an ISO string */}
                            <div className="text-xs text-text-tertiary font-medium mb-1">
                                {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </div>
                            <h1 className="text-3xl font-bold text-[#E9E9E9] tracking-tight">{meeting.title}</h1>
                        </div>

                        {/* Moved Actions: Follow-up & Share */}
                        <div className="flex items-center gap-2 mt-1">
                            <button className="flex items-center gap-2 px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-md text-xs font-medium text-text-primary transition-colors">
                                <Mail size={14} />
                                Follow-up email
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 ml-1"></span>
                            </button>
                            <button className="flex items-center gap-2 px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-md text-xs font-medium text-text-primary transition-colors">
                                <Link size={14} />
                                Share
                                <ChevronDown size={12} className="text-text-secondary" />
                            </button>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="flex items-center gap-1 mb-8 border-b border-border-subtle pb-0">
                        {['summary', 'transcript', 'usage'].map((tab) => (
                            <button
                                key={tab}
                                onClick={() => setActiveTab(tab as any)}
                                className={`
                                    px-4 py-2 text-xs font-medium rounded-t-lg transition-colors relative
                                    ${activeTab === tab ? 'text-text-primary bg-bg-input' : 'text-text-secondary hover:text-text-primary'}
                                `}
                            >
                                {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                {activeTab === tab && (
                                    <motion.div
                                        layoutId="activeTabIndicator"
                                        className="absolute bottom-0 left-0 right-0 h-px bg-accent-primary"
                                    />
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Tab Content */}
                    <div className="space-y-8">
                        {/* Using standard divs for content, framer motion for layout */}
                        {activeTab === 'summary' && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {/* Overview */}
                                {meeting.detailedSummary?.overview && (
                                    <p className="text-sm text-text-secondary leading-relaxed mb-6 pb-6 border-b border-border-subtle">
                                        {meeting.detailedSummary.overview}
                                    </p>
                                )}

                                {/* Action Items */}
                                <section className="mb-8">
                                    <div className="flex items-center justify-between mb-4">
                                        <h2 className="text-lg font-semibold text-[#E9E9E9]">Action Items</h2>
                                        <button className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-[#E9E9E9] transition-colors">
                                            <Copy size={12} />
                                            Copy full summary
                                        </button>
                                    </div>
                                    <ul className="space-y-3">
                                        {meeting.detailedSummary?.actionItems?.length ? meeting.detailedSummary.actionItems.map((item, i) => (
                                            <li key={i} className="flex items-start gap-3 group">
                                                <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-blue-500 transition-colors" />
                                                <p className="text-sm text-text-secondary leading-relaxed">{item}</p>
                                            </li>
                                        )) : <p className="text-text-tertiary text-sm">No action items generated.</p>}
                                    </ul>
                                </section>

                                {/* Key Points */}
                                <section>
                                    <h2 className="text-lg font-semibold text-[#E9E9E9] mb-4">Key Points</h2>
                                    <ul className="space-y-3">
                                        {meeting.detailedSummary?.keyPoints?.length ? meeting.detailedSummary.keyPoints.map((item, i) => (
                                            <li key={i} className="flex items-start gap-3 group">
                                                <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-purple-500 transition-colors" />
                                                <p className="text-sm text-text-secondary leading-relaxed">{item}</p>
                                            </li>
                                        )) : <p className="text-text-tertiary text-sm">No key points generated.</p>}
                                    </ul>
                                </section>
                            </motion.div>
                        )}

                        {activeTab === 'transcript' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                <div className="flex items-center justify-end mb-6">
                                    <button className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors">
                                        <Copy size={12} />
                                        Copy full transcript
                                    </button>
                                </div>
                                <div className="space-y-6">
                                    {meeting.transcript?.map((entry, i) => (
                                        <div key={i} className="group">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-xs font-semibold text-text-secondary">{entry.speaker === 'user' ? 'Me' : 'Them'}</span>
                                                <span className="text-xs text-text-tertiary font-mono">{entry.timestamp ? formatTime(entry.timestamp) : '0:00'}</span>
                                            </div>
                                            <p className="text-[#A4A4A7] text-[15px] leading-relaxed transition-colors">{entry.text}</p>
                                        </div>
                                    ))}
                                    {!meeting.transcript?.length && <p className="text-text-tertiary">No transcript available.</p>}
                                </div>
                            </motion.section>
                        )}

                        {activeTab === 'usage' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8 pb-10">
                                {meeting.usage?.map((interaction, i) => (
                                    <div key={i} className="space-y-4">
                                        {/* User Question */}
                                        {interaction.question && (
                                            <div className="flex justify-end">
                                                <div className="bg-[#0A84FF] text-white px-5 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%] text-[15px] font-medium leading-relaxed shadow-sm">
                                                    {interaction.question}
                                                </div>
                                            </div>
                                        )}

                                        {/* AI Answer */}
                                        {interaction.answer && (
                                            <div className="flex items-start gap-4">
                                                <div className="mt-1 w-6 h-6 rounded-full bg-bg-input flex items-center justify-center border border-border-subtle shrink-0">
                                                    <div className="w-3 h-3 text-text-tertiary">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                                                    </div>
                                                </div>
                                                <div>
                                                    <div className="text-[11px] text-text-tertiary mb-1.5 font-medium">{formatTime(interaction.timestamp)}</div>
                                                    <p className="text-[#A4A4A7] text-[15px] leading-relaxed whitespace-pre-wrap">{interaction.answer}</p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {!meeting.usage?.length && <p className="text-text-tertiary">No usage history.</p>}
                            </motion.section>
                        )}
                    </div>
                </motion.div>
            </main>

            {/* Floating Footer (Ask Bar) */}
            <div className="absolute bottom-0 left-0 right-0 p-6 flex justify-center pointer-events-none z-20">
                <div className="w-full max-w-[440px] relative group pointer-events-auto">
                    {/* Dark Glass Effect Input (Matching Reference) */}
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Ask about this meeting..."
                        className="w-full pl-5 pr-12 py-3 bg-[#1C1C1E]/40 backdrop-blur-md border border-white/[0.08] rounded-full text-sm text-[#E9E9E9] placeholder-text-tertiary/70 focus:outline-none focus:ring-1 focus:ring-white/10 focus:bg-[#1C1C1E]/60 transition-all shadow-xl"
                    />
                    <button
                        className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query ? 'bg-white text-black hover:scale-105' : 'bg-[#2C2C2E] text-[#E9E9E9] hover:bg-[#3A3A3C]'
                            }`}
                    >
                        <ArrowUp size={16} className="transform rotate-45" />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default MeetingDetails;
