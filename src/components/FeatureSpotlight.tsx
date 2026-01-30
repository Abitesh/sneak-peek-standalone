import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check } from 'lucide-react';
import mainui from "../UI_comp/mainui.png";

// --- Types ---

interface FeatureSlide {
    id: string;
    headline: string;
    subtitle: string;
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

    // --- Auto-Advance Logic ---

    useEffect(() => {
        if (isPaused) return;

        // Randomized interval between 6000ms and 8000ms
        const intervalDuration = 6000 + Math.random() * 2000;

        const timer = setTimeout(() => {
            setCurrentIndex((prev) => (prev + 1) % FEATURES.length);
        }, intervalDuration);

        return () => clearTimeout(timer);
    }, [currentIndex, isPaused]);


    // --- Interaction Handlers ---

    const handleInterestClick = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent parent clicks

        if (isInterested) return; // Already marked

        const newState = { ...interestState, [currentFeature.id]: true };
        setInterestState(newState);
        localStorage.setItem('natively_feature_interest', JSON.stringify(newState));

        // Interaction triggers "Anonymous one-time ping"
        console.log(`[FeatureSpotlight] User registered interest in: ${currentFeature.id}`);

        // Note: We do NOT auto-advance immediately. Let the user see the success state.
        // The natural loop will continue after the pause is lifted/timeout hits.
    };

    return (
        <div
            className="relative h-full w-full overflow-hidden rounded-xl bg-gradient-to-br from-[#1C1C1E] to-[#151516] flex flex-col group select-none"
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => setIsPaused(false)}
            // Ensure container doesn't layout shift
            style={{ isolation: 'isolate' }}
        >
            {/* 1. Background (Ambient) - Reusing the premium asset from Launcher */}
            <div className="absolute inset-0 z-0 pointer-events-none">
                <img
                    src={mainui}
                    alt=""
                    className="w-full h-full object-cover opacity-60 scale-100 transition-transform duration-[2000ms] ease-out group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-black/20" /> {/* Slight dim for text contrast */}
            </div>

            {/* 2. Content Area (Centered) */}
            <div className="relative z-10 flex flex-col items-center justify-center h-full w-full px-6 text-center">

                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={currentFeature.id}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{
                            duration: 0.5,
                            ease: "easeInOut"
                        }}
                        className="flex flex-col items-center w-full"
                    >
                        {/* Micro Headline */}
                        <h2 className="text-[20px] font-semibold text-[#F5F5F7] mb-1 leading-tight tracking-wide drop-shadow-sm">
                            {currentFeature.headline}
                        </h2>

                        {/* One-line value statement */}
                        <p className="text-[14px] text-[#AEAEB2] font-medium leading-relaxed tracking-wide mb-6">
                            {currentFeature.subtitle}
                        </p>

                        {/* Action Button */}
                        <motion.button
                            onClick={handleInterestClick}
                            disabled={isInterested}
                            className={`
                                group/btn relative flex items-center gap-2 pl-4 pr-4 py-2 rounded-full 
                                text-[13px] font-medium transition-all duration-300
                                ${isInterested
                                    ? 'cursor-default opacity-90'
                                    : 'cursor-pointer hover:bg-white/5 active:scale-[0.98]'
                                }
                            `}
                            style={{
                                backdropFilter: 'blur(10px)',
                                backgroundColor: isInterested ? 'rgba(50, 200, 100, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                                border: `1px solid ${isInterested ? 'rgba(52, 211, 153, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
                                color: isInterested ? '#CDFAD1' : '#EBEBF5'
                            }}
                            aria-label={isInterested ? "Interest registered" : `Mark interest in ${currentFeature.headline}`}
                        >
                            <AnimatePresence mode="wait" initial={false}>
                                {isInterested ? (
                                    <motion.span
                                        key="complete"
                                        initial={{ opacity: 0, y: 5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="flex items-center gap-2"
                                    >
                                        Interested <Check size={14} strokeWidth={2.5} />
                                    </motion.span>
                                ) : (
                                    <motion.span
                                        key="cta"
                                        initial={{ opacity: 0, y: -5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="flex items-center gap-1.5"
                                    >
                                        Mark interest
                                        <ArrowRight
                                            size={14}
                                            className="transition-transform duration-300 group-hover/btn:translate-x-0.5"
                                        />
                                    </motion.span>
                                )}
                            </AnimatePresence>
                        </motion.button>
                    </motion.div>
                </AnimatePresence>

            </div>
        </div>
    );
};
