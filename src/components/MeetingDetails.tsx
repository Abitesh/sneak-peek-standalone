import React, { useState } from 'react';
import { ArrowLeft, Search, Mail, Link, ChevronDown, Play, ArrowUp, Copy, Check, MoreHorizontal, Settings, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import MeetingChatOverlay from './MeetingChatOverlay';
import EditableTextBlock from './EditableTextBlock';

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
        actionItemsTitle?: string;
        keyPointsTitle?: string;
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

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting: initialMeeting }) => {
    // We need local state for the meeting object to reflect optimistic updates
    const [meeting, setMeeting] = useState<Meeting>(initialMeeting);
    const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'usage'>('summary');
    const [query, setQuery] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [submittedQuery, setSubmittedQuery] = useState('');

    const handleSubmitQuestion = () => {
        if (query.trim()) {
            setSubmittedQuery(query);
            if (!isChatOpen) {
                setIsChatOpen(true);
            }
            setQuery('');
        }
    };

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            handleSubmitQuestion();
        }
    };

    const handleCopy = async () => {
        let textToCopy = '';

        if (activeTab === 'summary' && meeting.detailedSummary) {
            textToCopy = `
Meeting: ${meeting.title}
Date: ${new Date(meeting.date).toLocaleDateString()}

OVERVIEW:
${meeting.detailedSummary.overview || ''}

ACTION ITEMS:
${meeting.detailedSummary.actionItems?.map(item => `- ${item}`).join('\n') || 'None'}

KEY POINTS:
${meeting.detailedSummary.keyPoints?.map(item => `- ${item}`).join('\n') || 'None'}
            `.trim();
        } else if (activeTab === 'transcript' && meeting.transcript) {
            textToCopy = meeting.transcript.map(t => `[${formatTime(t.timestamp)}] ${t.speaker === 'user' ? 'Me' : 'Them'}: ${t.text}`).join('\n');
        } else if (activeTab === 'usage' && meeting.usage) {
            textToCopy = meeting.usage.map(u => `Q: ${u.question || ''}\nA: ${u.answer || ''}`).join('\n\n');
        }

        if (!textToCopy) return;

        try {
            await navigator.clipboard.writeText(textToCopy);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy content:', err);
        }
    };

    // UPDATE HANDLERS
    const handleTitleSave = async (newTitle: string) => {
        setMeeting(prev => ({ ...prev, title: newTitle }));
        if (window.electronAPI?.updateMeetingTitle) {
            await window.electronAPI.updateMeetingTitle(meeting.id, newTitle);
        }
    };

    const handleOverviewSave = async (newOverview: string) => {
        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                overview: newOverview
            }
        }));
        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { overview: newOverview });
        }
    };

    const handleActionItemSave = async (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.actionItems || [])];
        if (!newVal.trim()) {
            // Optional: Remove empty items? For now just keep empty or update
        }
        newItems[index] = newVal;

        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                actionItems: newItems
            }
        }));

        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { actionItems: newItems });
        }
    };

    const handleKeyPointSave = async (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
        newItems[index] = newVal;

        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                keyPoints: newItems
            }
        }));

        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { keyPoints: newItems });
        }
    };


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
                        <div className="w-full pr-4">
                            {/* Date formatting could be improved to use meeting.date if it's an ISO string */}
                            <div className="text-xs text-text-tertiary font-medium mb-1">
                                {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </div>

                            {/* Editable Title */}
                            <EditableTextBlock
                                initialValue={meeting.title}
                                onSave={handleTitleSave}
                                tagName="h1"
                                className="text-3xl font-bold text-[#E9E9E9] tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors"
                                multiline={false}
                            />
                        </div>

                        {/* Moved Actions: Follow-up & Share (REMOVED per user request) */}
                        {/* <div className="flex items-center gap-2 mt-1"> ... </div> */}
                    </div>

                    {/* Tabs */}
                    {/* Designing Tabs to match reference 1:1 (Dark Pill Container) */}
                    <div className="flex items-center justify-between mb-8">
                        <div className="bg-[#121214] p-1 rounded-xl inline-flex items-center gap-0.5 border border-white/[0.08]">
                            {['summary', 'transcript', 'usage'].map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab as any)}
                                    className={`
                                        relative px-3 py-1 text-[13px] font-medium rounded-lg transition-all duration-200 z-10
                                        ${activeTab === tab ? 'text-[#E9E9E9]' : 'text-[#888889] hover:text-[#B0B0B1]'}
                                    `}
                                >
                                    {activeTab === tab && (
                                        <motion.div
                                            layoutId="activeTabBackground"
                                            className="absolute inset-0 bg-[#3A3A3C] rounded-lg -z-10 shadow-sm"
                                            initial={false}
                                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                                        />
                                    )}
                                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </div>

                        {/* Copy Button - Inline with Tabs (Always visible) */}
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-2 text-xs font-medium text-[#A4A4A7] hover:text-white transition-colors"
                        >
                            {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                            {isCopied ? 'Copied' : activeTab === 'summary' ? 'Copy full summary' : activeTab === 'transcript' ? 'Copy full transcript' : 'Copy usage'}
                        </button>
                    </div>

                    {/* Tab Content */}
                    <div className="space-y-8">
                        {/* Using standard divs for content, framer motion for layout */}
                        {activeTab === 'summary' && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {/* Overview */}
                                <div className="mb-6 pb-6 border-b border-border-subtle">
                                    <EditableTextBlock
                                        initialValue={meeting.detailedSummary?.overview || ''}
                                        onSave={handleOverviewSave}
                                        tagName="p"
                                        className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 py-1 rounded-md transition-colors"
                                        placeholder="Add an overview..."
                                    />
                                </div>

                                {/* Action Items */}
                                <section className="mb-8">
                                    <div className="flex items-center justify-between mb-4">
                                        <EditableTextBlock
                                            initialValue={meeting.detailedSummary?.actionItemsTitle || 'Action Items'}
                                            onSave={(val) => {
                                                setMeeting(prev => ({
                                                    ...prev,
                                                    detailedSummary: { ...prev.detailedSummary!, actionItemsTitle: val }
                                                }));
                                                window.electronAPI?.updateMeetingSummary(meeting.id, { actionItemsTitle: val });
                                            }}
                                            tagName="h2"
                                            className="text-lg font-semibold text-[#E9E9E9] -ml-2 px-2 py-1 rounded-sm transition-colors"
                                            multiline={false}
                                        />
                                    </div>
                                    <ul className="space-y-3">
                                        {(meeting.detailedSummary?.actionItems?.length ? meeting.detailedSummary.actionItems : ['']).map((item, i) => (
                                            <li key={i} className="flex items-start gap-3 group">
                                                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-blue-500 transition-colors shrink-0" />
                                                <div className="flex-1">
                                                    <EditableTextBlock
                                                        initialValue={item}
                                                        onSave={(val) => handleActionItemSave(i, val)}
                                                        tagName="p"
                                                        className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
                                                        placeholder={meeting.detailedSummary?.actionItems?.length ? "Type an action item..." : "Click to add an action item..."}
                                                        onEnter={() => {
                                                            const newItems = [...(meeting.detailedSummary?.actionItems || [])];
                                                            // Insert after current
                                                            newItems.splice(i + 1, 0, "");
                                                            setMeeting(prev => ({
                                                                ...prev,
                                                                detailedSummary: { ...prev.detailedSummary!, actionItems: newItems }
                                                            }));
                                                            // We rely on autoFocus logic in EditableTextBlock for the new item.
                                                            // However, mapped components re-render. We need a way to track which index should be focused.
                                                            // This is tricky with pure React re-renders unless we accept that the new component mounts with autoFocus.
                                                            // Since we splice and re-render, the component at i+1 is techincally "new" (different key if we use index as key, which we are).
                                                            // Using index as key is good here because we WANT the new item at that index to mount as new.
                                                        }}
                                                        autoFocus={item === "" && i === (meeting.detailedSummary?.actionItems?.length || 0)} // Rudimentary check for newly added empty item?
                                                    // Actually, if we add text at i+1, the component at key=i+1 will be new.
                                                    // So passing autoFocus={item === ""} might suffice if we only add empty items.
                                                    // But existing empty items shouldn't auto-focus on load.
                                                    // Better strategy: Simple autoFocus={true} on the new item is handled by React mounting it.
                                                    // But we need to distinguish "initial load with empty item" vs "user created new item".
                                                    // For now, let's rely on user clicking empty placeholder if it's the only one.
                                                    // For "Enter", the newly created item at i+1 will mount. If we pass autoFocus={true} to it, it works.
                                                    />
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                </section>

                                {/* Key Points */}
                                <section>
                                    <div className="flex items-center justify-between mb-4">
                                        <EditableTextBlock
                                            initialValue={meeting.detailedSummary?.keyPointsTitle || 'Key Points'}
                                            onSave={(val) => {
                                                setMeeting(prev => ({
                                                    ...prev,
                                                    detailedSummary: { ...prev.detailedSummary!, keyPointsTitle: val }
                                                }));
                                                window.electronAPI?.updateMeetingSummary(meeting.id, { keyPointsTitle: val });
                                            }}
                                            tagName="h2"
                                            className="text-lg font-semibold text-[#E9E9E9] -ml-2 px-2 py-1 rounded-sm transition-colors"
                                            multiline={false}
                                        />
                                    </div>
                                    <ul className="space-y-3">
                                        {(meeting.detailedSummary?.keyPoints?.length ? meeting.detailedSummary.keyPoints : ['']).map((item, i) => (
                                            <li key={i} className="flex items-start gap-3 group">
                                                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-purple-500 transition-colors shrink-0" />
                                                <div className="flex-1">
                                                    <EditableTextBlock
                                                        initialValue={item}
                                                        onSave={(val) => handleKeyPointSave(i, val)}
                                                        tagName="p"
                                                        className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
                                                        placeholder={meeting.detailedSummary?.keyPoints?.length ? "Type a key point..." : "Click to add a key point..."}
                                                        onEnter={() => {
                                                            const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
                                                            newItems.splice(i + 1, 0, "");
                                                            setMeeting(prev => ({
                                                                ...prev,
                                                                detailedSummary: { ...prev.detailedSummary!, keyPoints: newItems }
                                                            }));
                                                        }}
                                                        autoFocus={item === "" && i === (meeting.detailedSummary?.keyPoints?.length ? meeting.detailedSummary.keyPoints.length - 1 : 0)}
                                                    />
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            </motion.div>
                        )}

                        {activeTab === 'transcript' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                <div className="space-y-6">
                                    {meeting.transcript?.map((entry, i) => (
                                        <div key={i} className="group">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-xs font-semibold text-text-secondary">{entry.speaker === 'user' ? 'Me' : 'Them'}</span>
                                                <span className="text-xs text-text-tertiary font-mono">{entry.timestamp ? formatTime(entry.timestamp) : '0:00'}</span>
                                            </div>
                                            <p className="text-[#A4A4A7] text-[15px] leading-relaxed transition-colors select-text cursor-text">{entry.text}</p>
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
            <div className={`absolute bottom-0 left-0 right-0 p-6 flex justify-center pointer-events-none ${isChatOpen ? 'z-50' : 'z-20'}`}>
                <div className="w-full max-w-[440px] relative group pointer-events-auto">
                    {/* Dark Glass Effect Input (Matching Reference) */}
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        placeholder="Ask about this meeting..."
                        className="w-full pl-5 pr-12 py-3 bg-[#1C1C1E]/20 backdrop-blur-xl border border-white/[0.08] rounded-full text-sm text-[#E9E9E9] placeholder-text-tertiary/70 focus:outline-none transition-all shadow-xl"
                    />
                    <button
                        onClick={handleSubmitQuestion}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-white text-black hover:scale-105' : 'bg-[#2C2C2E] text-[#E9E9E9] hover:bg-[#3A3A3C]'
                            }`}
                    >
                        <ArrowUp size={16} className="transform rotate-45" />
                    </button>
                </div>
            </div>

            {/* Chat Overlay */}
            <MeetingChatOverlay
                isOpen={isChatOpen}
                onClose={() => {
                    setIsChatOpen(false);
                    setQuery('');
                    setSubmittedQuery('');
                }}
                meetingContext={{
                    id: meeting.id,  // Required for RAG queries
                    title: meeting.title,
                    summary: meeting.detailedSummary?.overview,
                    keyPoints: meeting.detailedSummary?.keyPoints,
                    actionItems: meeting.detailedSummary?.actionItems,
                    transcript: meeting.transcript
                }}
                initialQuery={submittedQuery}
                onNewQuery={(newQuery) => {
                    setSubmittedQuery(newQuery);
                }}
            />
        </div>
    );
};

export default MeetingDetails;
