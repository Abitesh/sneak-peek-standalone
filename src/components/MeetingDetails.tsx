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

    return (
        <div className="h-full w-full flex flex-col bg-bg-primary text-text-primary font-sans overflow-hidden">
            {/* Main Content */}
            <main className="flex-1 overflow-y-auto custom-scrollbar">
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    className="max-w-4xl mx-auto px-8 py-8"
                >
                    {/* Meta Info & Actions Row */}
                    <div className="flex items-start justify-between mb-6">
                        <div>
                            {/* Date formatting could be improved to use meeting.date if it's an ISO string */}
                            <div className="text-xs text-text-tertiary font-medium mb-1">
                                {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </div>
                            <h1 className="text-3xl font-bold text-text-primary tracking-tight">{meeting.title}</h1>
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
                                        <h2 className="text-lg font-semibold text-text-primary">Action Items</h2>
                                        <button className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors">
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
                                    <h2 className="text-lg font-semibold text-text-primary mb-4">Key Points</h2>
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
                                            <p className="text-text-primary text-[15px] leading-relaxed transition-colors">{entry.text}</p>
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
                                                    <p className="text-text-primary text-[15px] leading-relaxed whitespace-pre-wrap">{interaction.answer}</p>
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

            {/* Footer */}
            <footer className="shrink-0 px-8 py-6 border-t border-border-subtle bg-bg-secondary flex items-center justify-center gap-4">
                <button className="flex items-center gap-2 px-4 py-2 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-full text-sm font-medium text-text-primary transition-colors">
                    <Play size={14} fill="currentColor" />
                    Resume Session
                </button>

                <div className="flex-1 max-w-xl relative">
                    <input
                        type="text"
                        placeholder="Ask about this meeting..."
                        className="w-full pl-5 pr-10 py-2.5 bg-bg-input border border-border-subtle rounded-full text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-muted transition-all"
                    />
                    <button className="absolute right-1.5 top-1.5 p-1.5 bg-bg-input hover:bg-bg-elevated rounded-full text-text-tertiary transition-colors">
                        <ArrowUp size={14} />
                    </button>
                </div>
            </footer>
        </div>
    );
};

export default MeetingDetails;
