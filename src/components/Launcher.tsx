import React, { useState, useEffect } from 'react';
import { ToggleLeft, ToggleRight, Search, Zap, Calendar, ArrowRight, ArrowLeft, MoreHorizontal, Globe, Clock, ChevronRight, Settings, RefreshCw, Eye, EyeOff, Ghost, Plus, Mail, Link as LinkIcon, ChevronDown, Trash2, Bell, Check } from 'lucide-react';
import icon from "./icon.png";
import mainui from "../UI_comp/mainui.png";
import calender from "../UI_comp/calender.png";
import ConnectCalendarButton from './ui/ConnectCalendarButton';
import MeetingDetails from './MeetingDetails';
import TopSearchPill from './TopSearchPill';
import GlobalChatOverlay from './GlobalChatOverlay';
import { motion, AnimatePresence } from 'framer-motion';

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    detailedSummary?: {
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
    active?: boolean; // UI state
    time?: string; // Optional for compatibility
}

interface LauncherProps {
    onStartMeeting: () => void;
    onOpenSettings: () => void;
}

// Helper to format date groups
const getGroupLabel = (dateStr: string) => {
    if (dateStr === "Today") return "Today"; // Backward compatibility

    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (checkDate.getTime() === today.getTime()) return "Today";
    if (checkDate.getTime() === yesterday.getTime()) return "Yesterday";

    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// Helper to format time (e.g. 3:14pm)
const formatTime = (dateStr: string) => {
    if (dateStr === "Today") return "Just now"; // Legacy
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
};

const Launcher: React.FC<LauncherProps> = ({ onStartMeeting, onOpenSettings }) => {
    const [meetings, setMeetings] = useState<Meeting[]>([]);
    const [isDetectable, setIsDetectable] = useState(false);
    const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
    const [upcomingEvents, setUpcomingEvents] = useState<any[]>([]);
    const [isPrepared, setIsPrepared] = useState(false);
    const [preparedEvent, setPreparedEvent] = useState<any>(null);
    const [isCalendarConnected, setIsCalendarConnected] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showNotification, setShowNotification] = useState(false);
    const [isInterested, setIsInterested] = useState(false);

    // Global search state (for AI chat overlay)
    const [isGlobalChatOpen, setIsGlobalChatOpen] = useState(false);
    const [submittedGlobalQuery, setSubmittedGlobalQuery] = useState('');

    const fetchMeetings = () => {
        if (window.electronAPI && window.electronAPI.getRecentMeetings) {
            window.electronAPI.getRecentMeetings().then(setMeetings).catch(err => console.error("Failed to fetch meetings:", err));
        }
    };

    const fetchEvents = () => {
        if (window.electronAPI && window.electronAPI.getUpcomingEvents) {
            window.electronAPI.getUpcomingEvents().then(setUpcomingEvents).catch(err => console.error("Failed to fetch events:", err));
        }
    }

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            if (window.electronAPI && window.electronAPI.calendarRefresh) {
                setShowNotification(true);
                await window.electronAPI.calendarRefresh();
                fetchEvents();
                fetchMeetings();
                setTimeout(() => {
                    setShowNotification(false);
                }, 3000);
            } else {
                console.warn("electronAPI.calendarRefresh not found");
            }
        } catch (e) {
            console.error("Refresh failed in handleRefresh:", e);
        } finally {
            // Ensure distinct feedback provided (min 500ms spin)
            setTimeout(() => setIsRefreshing(false), 500);
        }
    };

    useEffect(() => {
        console.log("Launcher mounted");
        // Seed demo data if needed (safe to call always)
        if (window.electronAPI && window.electronAPI.invoke) {
            window.electronAPI.invoke('seed-demo').catch(err => console.error("Failed to seed demo:", err));
        }

        fetchMeetings();
        fetchEvents();

        // Listen for background updates (e.g. after meeting processing finishes)
        const removeListener = window.electronAPI.onMeetingsUpdated(() => {
            console.log("Received meetings-updated event");
            fetchMeetings();
        });

        // Simple polling for events every minute
        const interval = setInterval(fetchEvents, 60000);

        return () => {
            if (removeListener) removeListener();
            clearInterval(interval);
        };
    }, []);

    // Filter next meeting (within 60 mins)
    const nextMeeting = upcomingEvents.find(e => {
        const diff = new Date(e.startTime).getTime() - Date.now();
        return diff > -5 * 60000 && diff < 60 * 60000; // -5 min to +60 min
    });

    const handlePrepare = (event: any) => {
        setPreparedEvent(event);
        setIsPrepared(true);
    };

    const handleStartPreparedMeeting = async () => {
        if (!preparedEvent) return;
        try {
            await window.electronAPI.invoke('start-meeting', {
                title: preparedEvent.title,
                calendarEventId: preparedEvent.id,
                source: 'calendar'
            });
            setIsPrepared(false);
        } catch (e) {
            console.error("Failed to start prepared meeting", e);
        }
    };

    if (!window.electronAPI) {
        return <div className="text-white p-10">Error: Electron API not initialized. Check preload script.</div>;
    }

    const toggleDetectable = () => {
        const newState = !isDetectable;
        setIsDetectable(newState);
        window.electronAPI?.setUndetectable(!newState);
    };

    // Group meetings
    const groupedMeetings = meetings.reduce((acc, meeting) => {
        const label = getGroupLabel(meeting.date);
        if (!acc[label]) acc[label] = [];
        acc[label].push(meeting);
        return acc;
    }, {} as Record<string, Meeting[]>);

    // Group order (Today, Yesterday, then others sorted new to old is implicit via API return order ideally, 
    // but JS object key order isn't guaranteed. We can use a Map or just known keys.)
    // Simple sort for keys:
    const sortedGroups = Object.keys(groupedMeetings).sort((a, b) => {
        if (a === 'Today') return -1;
        if (b === 'Today') return 1;
        if (a === 'Yesterday') return -1;
        if (b === 'Yesterday') return 1;
        // Approximation for others: parse date
        return new Date(b).getTime() - new Date(a).getTime();
    });


    const [forwardMeeting, setForwardMeeting] = useState<Meeting | null>(null);
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

    // Global click listener to close menu
    useEffect(() => {
        const handleClickOutside = () => setActiveMenuId(null);
        window.addEventListener('click', handleClickOutside);
        return () => window.removeEventListener('click', handleClickOutside);
    }, []);

    const handleOpenMeeting = async (meeting: Meeting) => {
        setForwardMeeting(null); // Clear forward history on new navigation
        console.log("[Launcher] Opening meeting:", meeting.id);
        // Fetch full meeting details including transcript and usage
        if (window.electronAPI && window.electronAPI.getMeetingDetails) {
            try {
                console.log("[Launcher] Fetching full meeting details...");
                const fullMeeting = await window.electronAPI.getMeetingDetails(meeting.id);
                console.log("[Launcher] Got meeting details:", fullMeeting);
                console.log("[Launcher] Transcript count:", fullMeeting?.transcript?.length);
                console.log("[Launcher] Usage count:", fullMeeting?.usage?.length);
                if (fullMeeting) {
                    setSelectedMeeting(fullMeeting);
                    return;
                }
            } catch (err) {
                console.error("[Launcher] Failed to fetch meeting details:", err);
            }
        } else {
            console.warn("[Launcher] getMeetingDetails not available on electronAPI");
        }
        // Fallback to list-view data if fetch fails
        setSelectedMeeting(meeting);
    };

    const handleBack = () => {
        setForwardMeeting(selectedMeeting);
        setSelectedMeeting(null);
    };

    const handleForward = () => {
        if (forwardMeeting) {
            setSelectedMeeting(forwardMeeting);
            setForwardMeeting(null);
        }
    };

    // Helper to format duration to mm:ss or mmm:ss
    const formatDurationPill = (durationStr: string) => {
        // Assume format "X min"
        const minutes = parseInt(durationStr.replace('min', '').trim()) || 0;
        const mm = minutes.toString().padStart(2, '0');
        return `${mm}:00`;
    };

    return (
        <div className="h-full w-full flex flex-col bg-bg-primary text-text-primary font-sans overflow-hidden selection:bg-accent-secondary/30">
            {/* 1. Header (Static) */}
            <header className="relative h-[40px] shrink-0 flex items-center justify-between pl-0 pr-2 drag-region select-none bg-bg-secondary border-b border-border-subtle">
                {/* Left: Spacing for Traffic Lights + Navigation Arrows */}
                <div className="flex items-center gap-1 no-drag">
                    <div className="w-[70px]" /> {/* Traffic Light Spacer */}

                    {/* Back Button */}
                    <button
                        onClick={selectedMeeting ? handleBack : undefined}
                        disabled={!selectedMeeting}
                        className={`
                            transition-all duration-300 p-1 flex items-center justify-center mt-1 ml-2
                            ${selectedMeeting
                                ? 'text-text-secondary hover:text-text-primary hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)] cursor-pointer'
                                : 'text-text-tertiary opacity-50 cursor-default'}
                        `}
                    >
                        <ArrowLeft size={16} />
                    </button>

                    {/* Forward Button */}
                    <button
                        onClick={handleForward}
                        disabled={!forwardMeeting}
                        className={`
                            transition-all duration-300 p-1 flex items-center justify-center mt-1
                            ${forwardMeeting
                                ? 'text-text-secondary hover:text-text-primary hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)] cursor-pointer'
                                : 'text-text-tertiary opacity-0 cursor-default'}
                        `}
                    >
                        <ArrowRight size={16} />
                    </button>
                </div>


                {/* Center: Spotlight-style Search Pill */}
                <TopSearchPill
                    meetings={meetings}
                    onAIQuery={(query) => {
                        setSubmittedGlobalQuery(query);
                        setIsGlobalChatOpen(true);
                    }}
                    onLiteralSearch={(query) => {
                        // For now, also use AI query for literal search
                        // Could be enhanced to do fuzzy filtering in the UI
                        setSubmittedGlobalQuery(query);
                        setIsGlobalChatOpen(true);
                    }}
                    onOpenMeeting={(meetingId) => {
                        const meeting = meetings.find(m => m.id === meetingId);
                        if (meeting) {
                            handleOpenMeeting(meeting);
                        }
                    }}
                />

                {/* Right: Actions */}
                <div className="flex items-center gap-3 no-drag">
                    <button
                        onClick={onOpenSettings}
                        className="p-2 text-text-secondary hover:text-text-primary transition-all duration-300 hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                        title="Settings"
                    >
                        <Settings size={18} />
                    </button>
                </div>
            </header>

            <AnimatePresence mode="wait">
                {selectedMeeting ? (
                    <motion.div
                        key="details"
                        className="flex-1 overflow-hidden"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                    >
                        <MeetingDetails
                            meeting={selectedMeeting}
                            onBack={handleBack}
                            onOpenSettings={onOpenSettings}
                        />
                    </motion.div>
                ) : (
                    <motion.div
                        key="launcher"
                        className="flex-1 flex flex-col overflow-hidden"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                    >

                        {/* Main Area - Fixed Top, Scrollable Bottom */}
                        {/* Top Section is now effectively static due to parent flex col */}

                        {/* TOP SECTION: Grey Background (Scrolls with content) */}
                        <section className="bg-bg-elevated px-8 pt-6 pb-8 border-b border-border-subtle shrink-0">
                            <div className="max-w-4xl mx-auto space-y-6">
                                {/* 1.5. Hero Header (Title + Controls + CTA) */}
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <h1 className="text-3xl font-celeb-light font-medium text-text-primary tracking-wide drop-shadow-sm">My Natively</h1>

                                        {/* Refresh Button */}
                                        <button
                                            onClick={handleRefresh}
                                            disabled={isRefreshing}
                                            className={`p-2 text-text-secondary hover:text-text-primary hover:bg-white/10 rounded-full transition-colors ${isRefreshing ? 'animate-spin text-blue-400' : ''}`}
                                            title="Refresh State"
                                        >
                                            <RefreshCw size={18} />
                                        </button>

                                        {/* Detectable Toggle Pill */}
                                        <div className="flex items-center gap-3 bg-[#101011] border border-border-muted rounded-full px-3 py-1.5 min-w-[140px]">
                                            {isDetectable ? (
                                                <Ghost
                                                    size={14}
                                                    strokeWidth={2} // Using 2 for clearer visibility
                                                    className="text-white transition-colors"
                                                />
                                            ) : (
                                                <svg
                                                    width="14"
                                                    height="14"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    className="transition-colors"
                                                >
                                                    <path
                                                        d="M12 2C7.58172 2 4 5.58172 4 10V22L7 19L9.5 21.5L12 19L14.5 21.5L17 19L20 22V10C20 5.58172 16.4183 2 12 2Z"
                                                        fill="white"
                                                    />
                                                    <circle cx="9" cy="10" r="1.5" fill="black" />
                                                    <circle cx="15" cy="10" r="1.5" fill="black" />
                                                </svg>
                                            )}
                                            <span className={`text-xs font-medium flex-1 transition-colors text-[#B7B7B8]`}>
                                                {isDetectable ? "Detectable" : "Undetectable"}
                                            </span>
                                            <div
                                                className={`w-8 h-4 rounded-full relative cursor-pointer transition-colors ${!isDetectable ? 'bg-blue-500' : 'bg-zinc-700'}`}
                                                onClick={toggleDetectable}
                                            >
                                                <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${!isDetectable ? 'left-[18px]' : 'left-0.5'}`} />
                                            </div>
                                        </div>
                                    </div>

                                    {/* Start Natively CTA Pill */}
                                    <button
                                        onClick={onStartMeeting}
                                        className="
                                    group relative overflow-hidden
                                    bg-gradient-to-b from-sky-400 via-sky-500 to-blue-600
                                    text-white
                                    px-6 py-3
                                    rounded-full
                                    font-celeb font-medium tracking-normal
                                    shadow-[inset_0_1px_1px_rgba(255,255,255,0.7),inset_0_-1px_2px_rgba(0,0,0,0.1),0_2px_10px_rgba(14,165,233,0.4),0_0_0_1px_rgba(255,255,255,0.15)]
                                    hover:shadow-[inset_0_1px_2px_rgba(255,255,255,0.8),inset_0_-1px_3px_rgba(0,0,0,0.15),0_6px_16px_rgba(14,165,233,0.6),0_0_0_1px_rgba(255,255,255,0.25)]
                                    hover:brightness-110
                                    hover:scale-[1.01]
                                    active:scale-[0.99]
                                    transition-all duration-500 ease-out
                                    flex items-center justify-center gap-3
                                    backdrop-blur-xl
                                "
                                    >
                                        {/* Top Highlight Band */}
                                        <div className="absolute inset-x-3 top-0 h-[40%] bg-gradient-to-b from-white/40 to-transparent blur-[2px] rounded-b-lg opacity-80 pointer-events-none" />

                                        {/* Internal "suspended light" glow */}
                                        <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />

                                        <img src={icon} alt="Logo" className="w-[18px] h-[18px] object-contain brightness-0 invert drop-shadow-[0_1px_2px_rgba(0,0,0,0.1)] opacity-90" />
                                        <span className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.1)] text-[20px] leading-none">Start Natively</span>
                                    </button>
                                </div>

                                {/* 2. Hero Section Cards */}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 h-[198px]">
                                    {/* PREPARED STATE CARD */}
                                    {isPrepared && preparedEvent ? (
                                        <div className="md:col-span-3 relative group rounded-xl overflow-hidden border border-emerald-500/30 bg-bg-secondary flex flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-emerald-900/40 via-bg-secondary to-bg-secondary">

                                            <div className="absolute top-4 right-4 text-emerald-400">
                                                <Zap size={16} className="text-yellow-400" />
                                            </div>

                                            <div className="text-center max-w-lg z-10">
                                                <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-bold tracking-wider mb-4 border border-emerald-500/20">
                                                    READY TO JOIN
                                                </span>
                                                <h2 className="text-2xl font-bold text-white mb-2">{preparedEvent.title}</h2>
                                                <p className="text-xs text-text-secondary mb-6 flex items-center justify-center gap-2">
                                                    <Calendar size={12} />
                                                    {new Date(preparedEvent.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - {new Date(preparedEvent.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                                    {preparedEvent.link && " • Link Ready"}
                                                </p>

                                                <div className="flex items-center gap-3 justify-center">
                                                    <button
                                                        onClick={handleStartPreparedMeeting}
                                                        className="bg-emerald-500 hover:bg-emerald-400 text-white px-8 py-3 rounded-xl text-sm font-semibold transition-all shadow-lg hover:shadow-emerald-500/25 active:scale-95 flex items-center gap-2"
                                                    >
                                                        Start Meeting
                                                        <ArrowRight size={16} />
                                                    </button>
                                                    <button
                                                        onClick={() => setIsPrepared(false)}
                                                        className="px-4 py-3 rounded-xl text-xs font-medium text-text-tertiary hover:text-white transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Glows */}
                                            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[300px] bg-emerald-500/10 blur-[100px] pointer-events-none" />
                                        </div>
                                    ) : (
                                        /* Dynamic Next Meeting OR Default Intro */
                                        nextMeeting ? (
                                            <div className="md:col-span-2 relative group rounded-xl overflow-hidden bg-bg-secondary flex flex-col">
                                                {/* Header */}
                                                <div className="p-5 flex-1 relative z-10">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                                        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">Up Next</span>
                                                        <span className="text-[11px] text-text-tertiary">• Starts in {Math.max(0, Math.ceil((new Date(nextMeeting.startTime).getTime() - Date.now()) / 60000))} min</span>
                                                    </div>

                                                    <h2 className="text-xl font-bold text-white leading-tight mb-1 line-clamp-2">
                                                        {nextMeeting.title}
                                                    </h2>

                                                    <div className="flex items-center gap-2 text-text-secondary text-xs mt-2">
                                                        <Calendar size={12} />
                                                        <span>{new Date(nextMeeting.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - {new Date(nextMeeting.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                                                        {nextMeeting.link && (
                                                            <>
                                                                <span className="opacity-20">|</span>
                                                                <LinkIcon size={12} />
                                                                <span className="truncate max-w-[150px]">Meeting Link Found</span>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Actions */}
                                                <div className="p-4 bg-bg-elevated/50 border-t border-border-subtle flex items-center gap-3">
                                                    <button
                                                        onClick={() => handlePrepare(nextMeeting)}
                                                        className="flex-1 bg-white/10 hover:bg-white/20 border border-white/10 text-white px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2"
                                                    >
                                                        <Zap size={13} className="text-yellow-400" />
                                                        Prepare
                                                    </button>
                                                    <button
                                                        onClick={onStartMeeting} // For now just start, later could link
                                                        className="px-4 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all"
                                                    >
                                                        Start now
                                                    </button>
                                                </div>

                                                {/* Background Decoration */}
                                                <div className="absolute top-0 right-0 w-[150px] h-[150px] bg-emerald-500/10 blur-[60px] pointer-events-none" />
                                            </div>
                                        ) : (
                                            <div className="md:col-span-2 relative group rounded-xl bg-gradient-to-br from-[#1C1C1E] to-[#151516] flex flex-col justify-between px-5 py-4 overflow-hidden">

                                                {/* Backdrop Image (Refined Visibility) */}
                                                <div className="absolute inset-0">
                                                    <img src={mainui} alt="" className="w-full h-full object-cover opacity-80 scale-100 transition-transform duration-700 group-hover:scale-105" />
                                                    <div className="absolute inset-0 bg-black/10" /> {/* Subtle tint to reduce raw brightness */}
                                                </div>

                                                {/* Content */}
                                                <div className="relative z-10 flex flex-col h-full items-center text-center">
                                                    {/* Header */}
                                                    <div className="flex flex-col items-center w-full">
                                                        <h2 className="text-[22px] font-semibold text-white mb-1 leading-tight drop-shadow-md tracking-wide">
                                                            Upcoming features
                                                        </h2>
                                                        <p className="text-[14px] text-white/[0.8] font-medium leading-relaxed drop-shadow-sm tracking-wide">
                                                            Answers, tailored to you.
                                                        </p>
                                                    </div>

                                                    {/* Feature List (Centered, No Bullets) */}
                                                    <div className="flex flex-col gap-1 mt-3 w-full">
                                                        <div className="text-[14px] text-white/[0.7] font-medium leading-relaxed">
                                                            GitHub integration for code context
                                                        </div>
                                                        <div className="text-[14px] text-white/[0.7] font-medium leading-relaxed">
                                                            Resume & job-description aware answers
                                                        </div>
                                                        <div className="text-[14px] text-white/[0.7] font-medium leading-relaxed">
                                                            Confidence timeline for fact checking
                                                        </div>
                                                    </div>

                                                    {/* Footer (Anchored Button) */}
                                                    <div className="mt-3 w-full flex justify-center">
                                                        <motion.button
                                                            layout
                                                            onClick={() => setIsInterested(!isInterested)}
                                                            className="group relative flex items-center gap-2 pl-4 pr-5 py-2 rounded-full text-[13px] font-medium ease-[cubic-bezier(0.23,1,0.32,1)] hover:brightness-125 active:scale-[0.98] overflow-hidden"
                                                            animate={{
                                                                backgroundColor: isInterested ? 'rgba(50, 80, 160, 0.6)' : 'rgba(20, 40, 70, 0.4)',
                                                            }}
                                                            transition={{
                                                                layout: { duration: 0.4, ease: [0.23, 1, 0.32, 1] }, // Direct morph A -> B
                                                                backgroundColor: { duration: 0.3 }
                                                            }}
                                                            style={{
                                                                backdropFilter: 'blur(14px)',
                                                                WebkitBackdropFilter: 'blur(14px)',
                                                                color: '#F4F6FA',
                                                            }}
                                                        >
                                                            {/* Gradient Border */}
                                                            <div
                                                                className="absolute inset-0 rounded-full pointer-events-none transition-opacity duration-300 group-hover:opacity-80"
                                                                style={{
                                                                    padding: '1px',
                                                                    background: isInterested ? 'linear-gradient(to right, #60A5FA, #8B5CF6)' : 'linear-gradient(to right, #60A5FA, #3B82F6)',
                                                                    WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                                                                    WebkitMaskComposite: 'xor',
                                                                    maskComposite: 'exclude',
                                                                    opacity: 0.6,
                                                                }}
                                                            />
                                                            {/* Inner Highlight */}
                                                            <div
                                                                className="absolute inset-0 rounded-full pointer-events-none"
                                                                style={{ boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08)' }}
                                                            />
                                                            <motion.div layout className="relative z-10 flex items-center gap-2 font-semibold">
                                                                {/* Text Transition */}
                                                                <AnimatePresence mode="popLayout" initial={false}>
                                                                    <motion.span
                                                                        layout
                                                                        key={isInterested ? 'interested' : 'mark'}
                                                                        initial={{ opacity: 0, scale: 0.9, y: 5, filter: 'blur(2px)' }}
                                                                        animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
                                                                        exit={{ opacity: 0, scale: 1.1, y: -5, filter: 'blur(2px)' }}
                                                                        transition={{ duration: 0.25, ease: "easeOut" }}
                                                                        className="block whitespace-nowrap"
                                                                    >
                                                                        {isInterested ? 'Interested' : 'Mark interest'}
                                                                    </motion.span>
                                                                </AnimatePresence>

                                                                {/* Icon Container (Stable) */}
                                                                <motion.div layout className="relative flex items-center justify-center -ml-0.5">
                                                                    <Bell size={13} className={`transition-all duration-300 ${isInterested ? 'fill-white/20' : ''}`} />
                                                                    <AnimatePresence>
                                                                        {isInterested && (
                                                                            <motion.div
                                                                                initial={{ scale: 0, opacity: 0 }}
                                                                                animate={{ scale: 1, opacity: 1 }}
                                                                                exit={{ scale: 0, opacity: 0 }}
                                                                                transition={{
                                                                                    type: "spring",
                                                                                    stiffness: 500,
                                                                                    damping: 30,
                                                                                    mass: 0.8
                                                                                }}
                                                                                className="absolute -top-1 -right-1 bg-emerald-500 rounded-full p-[1px] border border-[#1C1C1E]"
                                                                            >
                                                                                <Check size={6} className="text-white" strokeWidth={4} />
                                                                            </motion.div>
                                                                        )}
                                                                    </AnimatePresence>
                                                                </motion.div>
                                                            </motion.div>
                                                        </motion.button>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    )}



                                    {/* Right Secondary Card */}
                                    <div className="md:col-span-1 rounded-xl overflow-hidden bg-bg-elevated relative group flex flex-col items-center pt-6 text-center">
                                        {/* Backdrop Image */}
                                        <div className="absolute inset-0">
                                            <img src={calender} alt="" className="w-full h-full object-cover opacity-100 transition-opacity duration-500 translate-x--1 translate-y-[1px] scale-105" />
                                        </div>

                                        {/* Content Layer */}
                                        <div className="relative z-10 w-full flex flex-col items-center h-full">
                                            <h3 className="text-[19px] leading-tight mb-4">
                                                {isCalendarConnected ? (
                                                    <>
                                                        <span className="block font-semibold text-white">Calendar linked</span>
                                                        <span className="block font-medium text-white/60 text-[0.95em]">Events synced</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <span className="block font-semibold text-white">Link your calendar to</span>
                                                        <span className="block font-medium text-white/60 text-[0.95em]">see upcoming events</span>
                                                    </>
                                                )}
                                            </h3>

                                            <ConnectCalendarButton
                                                className="-translate-x-0.5"
                                                onConnect={() => setIsCalendarConnected(true)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* BOTTOM SECTION: Black Background (Scrollable content) */}
                        <main className="flex-1 overflow-y-auto custom-scrollbar bg-bg-primary">
                            <section className="px-8 py-8 min-h-full">
                                <div className="max-w-4xl mx-auto space-y-8">

                                    {/* Iterating Date Groups */}
                                    {sortedGroups.map((label) => (
                                        <section key={label}>
                                            <h3 className="text-[13px] font-medium text-text-secondary mb-3 pl-1">{label}</h3>
                                            <div className="space-y-1">
                                                {groupedMeetings[label].map((m) => (
                                                    <motion.div
                                                        key={m.id}
                                                        layoutId={`meeting-${m.id}`}
                                                        className="group relative flex items-center justify-between px-3 py-2 rounded-lg bg-transparent hover:bg-[#18181B] transition-colors cursor-pointer"
                                                        onClick={() => handleOpenMeeting(m)}
                                                    >
                                                        <div className={`font-medium text-[14px] max-w-[60%] truncate ${m.title === 'Processing...' ? 'text-blue-400 italic animate-pulse' : 'text-[#F4F4F5]'}`}>
                                                            {m.title}
                                                        </div>

                                                        {/* Time & Duration Section */}
                                                        <div className="flex items-center gap-4">
                                                            {m.title === 'Processing...' ? (
                                                                <div className="flex items-center gap-2">
                                                                    <RefreshCw size={12} className="animate-spin text-blue-500" />
                                                                    <span className="text-xs text-blue-500 font-medium">Finalizing...</span>
                                                                </div>
                                                            ) : (
                                                                <>
                                                                    <span className="relative z-10 bg-[#242426] text-[#9F9FAA] text-[9px] px-1.5 py-0.5 rounded-full font-medium min-w-[35px] text-center tracking-wide">
                                                                        {formatDurationPill(m.duration)}
                                                                    </span>

                                                                    {/* Time Text (Should fade out on hover) */}
                                                                    <span className="text-[13px] text-[#D4D4D8] font-medium min-w-[60px] text-right transition-all duration-200 ease-out group-hover:opacity-0 group-hover:translate-x-2 delayed-hover-exit">
                                                                        {formatTime(m.date)}
                                                                    </span>
                                                                </>
                                                            )}
                                                        </div>

                                                        {/* Context Menu Trigger (Slides in on hover) */}
                                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 translate-x-4 transition-all duration-300 ease-out group-hover:opacity-100 group-hover:translate-x-0">
                                                            <button
                                                                className="p-1.5 text-text-secondary hover:text-white transition-colors"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setActiveMenuId(activeMenuId === m.id ? null : m.id);
                                                                }}
                                                            >
                                                                <MoreHorizontal size={16} />
                                                            </button>
                                                        </div>

                                                        {/* Dropdown Menu */}
                                                        <AnimatePresence>
                                                            {activeMenuId === m.id && (
                                                                <motion.div
                                                                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                                                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                                                    exit={{ opacity: 0, scale: 0.95, y: 5 }}
                                                                    transition={{ duration: 0.1 }}
                                                                    className="absolute right-0 top-full mt-1 w-28 bg-[#1E1E1E]/80 backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl z-50 overflow-hidden"
                                                                    onClick={(e) => e.stopPropagation()}
                                                                >
                                                                    <div className="p-1 flex flex-col gap-0.5">
                                                                        <button
                                                                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-white/10 rounded-lg transition-colors text-left"
                                                                            onClick={() => {
                                                                                // Placeholder copy link
                                                                                console.log("Copy link clicked");
                                                                                setActiveMenuId(null);
                                                                            }}
                                                                        >
                                                                            <LinkIcon size={13} />
                                                                            Copy link
                                                                        </button>
                                                                        <button
                                                                            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-lg transition-colors text-left"
                                                                            onClick={async () => {
                                                                                if (window.electronAPI && window.electronAPI.deleteMeeting) {
                                                                                    const success = await window.electronAPI.deleteMeeting(m.id);
                                                                                    if (success) {
                                                                                        // Optimistic update or refetch
                                                                                        setMeetings(prev => prev.filter(meeting => meeting.id !== m.id));
                                                                                    }
                                                                                }
                                                                                setActiveMenuId(null);
                                                                            }}
                                                                        >
                                                                            <Trash2 size={13} />
                                                                            Delete
                                                                        </button>
                                                                    </div>
                                                                </motion.div>
                                                            )}
                                                        </AnimatePresence>
                                                    </motion.div>
                                                ))}
                                            </div>
                                        </section>
                                    ))}

                                    {meetings.length === 0 && (
                                        <div className="p-4 text-text-tertiary text-sm">No recent meetings.</div>
                                    )}

                                </div>
                            </section>
                        </main>
                    </motion.div>
                )}
            </AnimatePresence>



            {/* Notification Toast - Liquid Glass (macOS 26 Tahoe Concept) */}
            <AnimatePresence>
                {showNotification && (
                    <motion.div
                        initial={{ x: 300, opacity: 0, scale: 0.9 }}
                        animate={{ x: 0, opacity: 1, scale: 1 }}
                        exit={{ x: 300, opacity: 0, scale: 0.95 }}
                        transition={{ type: "spring", stiffness: 350, damping: 30, mass: 1 }}
                        className="fixed bottom-10 right-10 z-[2000] flex items-center gap-4 pl-4 pr-6 py-3.5 rounded-[18px] bg-[#2A2A2E]/40 backdrop-blur-xl saturate-[180%] border border-white/10 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-1px_0_rgba(255,255,255,0.05)] ring-1 ring-black/10"
                    >
                        {/* Liquid Icon Orb */}
                        <div className="relative flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-b from-blue-400/20 to-blue-600/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] border border-white/5">
                            <div className="absolute inset-0 rounded-full bg-blue-500/20 blur-md" />
                            <RefreshCw size={15} className="text-blue-300 animate-[spin_2s_linear_infinite] drop-shadow-[0_0_5px_rgba(59,130,246,0.6)]" />
                        </div>

                        {/* Text Content */}
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[14px] font-semibold text-white/95 leading-none tracking-tight drop-shadow-md">Refreshed</span>
                            <span className="text-[11px] text-blue-200/60 font-medium leading-none tracking-wide">Synced with calendar</span>
                        </div>

                        {/* Specular Highlight Overlay */}
                        <div className="absolute inset-0 rounded-[18px] bg-gradient-to-tr from-white/5 via-transparent to-transparent pointer-events-none" />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Global Chat Overlay */}
            <GlobalChatOverlay
                isOpen={isGlobalChatOpen}
                onClose={() => {
                    setIsGlobalChatOpen(false);
                    setSubmittedGlobalQuery('');
                }}
                initialQuery={submittedGlobalQuery}
            />
        </div >
    );
};

export default Launcher;
