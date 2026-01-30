import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check, Bell } from 'lucide-react';
import mainui from "../UI_comp/mainui.png";

// --- Types ---
// ... (rest of imports and types unchanged)

interface FeatureSlide {
    id: string;
    headline: string;
    subtitle: string;
    type?: 'feature' | 'support';
    actionLabel?: string;
    url?: string;
}

// --- Data ---

const FEATURES: FeatureSlide[] = [
    {
        id: 'tailored_answers',
        headline: 'Upcoming features',
        subtitle: 'Answers, tailored to you',
    },
    {
        id: 'github_context',
        headline: 'GitHub integration',
        subtitle: 'Use your real code as context',
    },
    {
        id: 'resume_aware',
        headline: 'Resume-aware answers',
        subtitle: 'Speak from your real experience',
    },
    {
        id: 'support_natively',
        headline: 'Support Development',
        subtitle: 'Contributions help keep the app independent, private, and continuously improving.',
        type: 'support',
        actionLabel: 'Contribute',
        url: 'https://github.com/sponsors/evinjohnn' // Placeholder
    }
];

// --- Component ---

export const FeatureSpotlight: React.FC = () => {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPaused, setIsPaused] = useState(false);

    // Interest state: map of feature ID -> boolean
    const [interestState, setInterestState] = useState<Record<string, boolean>>(() => {
        try {
            const saved = localStorage.getItem('natively_feature_interest');
            return saved ? JSON.parse(saved) : {};
        } catch (e) {
            return {};
        }
    });

    const currentFeature = FEATURES[currentIndex];
    const isInterested = interestState[currentFeature.id] || false;
    const isSupport = currentFeature.type === 'support';

    // --- Auto-Advance Logic ---

    useEffect(() => {
        if (isPaused) return;

        // Support slide has longer duration (10s), others 6-8s
        const baseDuration = isSupport ? 10000 : 6000;
        const randomFactor = isSupport ? 0 : Math.random() * 2000;
        const intervalDuration = baseDuration + randomFactor;

        const timer = setTimeout(() => {
            setCurrentIndex((prev) => (prev + 1) % FEATURES.length);
        }, intervalDuration);

        return () => clearTimeout(timer);
    }, [currentIndex, isPaused, isSupport]);


    // --- Interaction Handlers ---

    const handleActionClick = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent parent clicks

        if (isSupport && currentFeature.url) {
            window.open(currentFeature.url, '_blank');
            return;
        }

        const newState = { ...interestState, [currentFeature.id]: !isInterested };
        setInterestState(newState);
        localStorage.setItem('natively_feature_interest', JSON.stringify(newState));

        // Interaction triggers "Anonymous one-time ping"
        if (!isInterested) {
            console.log(`[FeatureSpotlight] User registered interest in: ${currentFeature.id}`);
        } else {
            console.log(`[FeatureSpotlight] User removed interest in: ${currentFeature.id}`);
        }
    };

    // --- Styles ---

    // Warmth tuning for support slide
    const subtitleColor = isSupport ? '#C8C8CC' : '#AEAEB2'; // Warmer gray vs Cool gray
    const buttonBg = isSupport
        ? (isInterested ? 'rgba(255, 100, 100, 0.15)' : 'rgba(255, 240, 240, 0.08)') // Warmer tint
        : (isInterested ? 'rgba(50, 200, 100, 0.15)' : 'rgba(255, 255, 255, 0.05)');

    const buttonBorder = isSupport
        ? (isInterested ? 'rgba(255, 150, 150, 0.3)' : 'rgba(255, 200, 200, 0.15)')
        : (isInterested ? 'rgba(52, 211, 153, 0.3)' : 'rgba(255, 255, 255, 0.1)');

    const buttonText = isSupport
        ? (isInterested ? '#FFD1D1' : '#F2F2F7')
        : (isInterested ? '#CDFAD1' : '#EBEBF5');

    return (
        <div
            className="relative h-full w-full overflow-hidden rounded-xl bg-gradient-to-br from-[#1C1C1E] to-[#151516] flex flex-col group select-none"
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => setIsPaused(false)}
            // Ensure container doesn't layout shift
            style={{ isolation: 'isolate' }}
        >
            {/* 1. Background (Ambient) with 85% opacity as requested */}
            <div className="absolute inset-0 z-0 pointer-events-none">
                <img
                    src={mainui}
                    alt=""
                    className="w-full h-full object-cover opacity-85 scale-100 transition-transform duration-[2000ms] ease-out group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-black/20" /> {/* Slight dim for text contrast */}
            </div>

            {/* 2. Content Area (Centered) */}
            <div className="relative z-10 flex flex-col items-center justify-center h-full w-full px-6 text-center">

                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={currentFeature.id}
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        transition={{
                            duration: 0.4,
                            ease: [0.16, 1, 0.3, 1] // Apple ease
                        }}
                        className="flex flex-col items-center w-full max-w-[440px]"
                    >
                        {/* Title */}
                        <h2
                            className="mb-2 text-white drop-shadow-sm"
                            style={{
                                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text"',
                                fontSize: '26px',
                                fontWeight: 500,
                                letterSpacing: '-0.02em',
                                lineHeight: 1.2,
                            }}
                        >
                            {currentFeature.headline}
                        </h2>

                        {/* Subtitle */}
                        <p
                            className="mb-6 antialiased"
                            style={{
                                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text"',
                                fontSize: '15px',
                                fontWeight: 400,
                                lineHeight: 1.5,
                                color: 'rgba(255,255,255,0.75)',
                                maxWidth: '380px'
                            }}
                        >
                            {currentFeature.subtitle}
                        </p>

                        {/* Primary Action Button - Connect Calendar Style Alignment */}
                        <motion.button
                            onClick={handleActionClick}
                            className={`
                                group relative
                                flex items-center justify-center gap-3
                                px-10 py-2.5
                                rounded-full
                                text-[13px] font-medium
                                transition-all duration-300 ease-out
                                hover:brightness-125
                                active:scale-[0.98]
                                overflow-hidden
                                cursor-pointer
                            `}
                            style={{
                                minWidth: '220px', // Match the "Connected" ratio visually
                                backgroundColor: isSupport
                                    ? 'rgba(80, 20, 40, 0.35)'
                                    : (isInterested ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.08)'),
                                backdropFilter: 'blur(14px)',
                                WebkitBackdropFilter: 'blur(14px)',
                                color: '#F4F6FA',
                            }}
                        >
                            {/* Gradient Border (Connect Button Technique) */}
                            <div
                                className="absolute inset-0 rounded-full pointer-events-none transition-opacity duration-300 group-hover:opacity-80"
                                style={{
                                    padding: '1px',
                                    background: isSupport
                                        ? 'linear-gradient(to right, #FDA4AF, #F43F5E)'
                                        : 'linear-gradient(to right, #FFFFFF, #A1A1AA)',
                                    WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                                    WebkitMaskComposite: 'xor',
                                    maskComposite: 'exclude',
                                    opacity: 0.6,
                                }}
                            />

                            {/* Inner Highlight */}
                            <div
                                className="absolute inset-0 rounded-full pointer-events-none"
                                style={{
                                    boxShadow: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.08)',
                                }}
                            />

                            <AnimatePresence mode="wait" initial={false}>
                                <motion.span
                                    key={isInterested ? 'interested' : 'cta'}
                                    initial={{ opacity: 0, y: isInterested ? 5 : -5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: isInterested ? -5 : 5 }}
                                    className="flex items-center gap-2.5 font-semibold relative z-10"
                                >
                                    <span>
                                        {isInterested && !isSupport
                                            ? 'Interested'
                                            : (currentFeature.actionLabel || 'Mark interest')
                                        }
                                    </span>

                                    {/* Bell Icon with conditional ringing animation */}
                                    <motion.div
                                        animate={isInterested ? {
                                            rotate: [0, -10, 10, -10, 10, 0],
                                        } : {}}
                                        transition={isInterested ? {
                                            duration: 0.5,
                                            repeat: Infinity,
                                            repeatDelay: 2,
                                            ease: "easeInOut"
                                        } : {}}
                                    >
                                        <Bell
                                            size={14}
                                            className={`${isInterested ? 'text-blue-400' : 'opacity-80'}`}
                                            fill={isInterested ? "currentColor" : "none"}
                                        />
                                    </motion.div>
                                </motion.span>
                            </AnimatePresence>
                        </motion.button>
                    </motion.div>
                </AnimatePresence>

            </div>
        </div>
    );
};
