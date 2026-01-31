import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check, Bell, Sparkles } from 'lucide-react';
import mainui from "../UI_comp/mainui.png";

// --- Types ---
// ... (rest of imports and types unchanged)

interface FeatureSlide {
    id: string;
    headline: string;
    subtitle: string;
    type?: 'feature' | 'support' | 'premium';
    actionLabel?: string;
    url?: string;
    eyebrow?: string;
    bullets?: string[];
    footer?: string;
}

// --- Data ---

const FEATURES: FeatureSlide[] = [
    {
        id: 'tailored_answers',
        headline: 'Upcoming features',
        subtitle: 'Answers, tailored to you',
        bullets: ['Repo aware explanations', 'Resume grounded responses'],
        footer: 'Designed to work silently during live interviews.',
        type: 'premium',
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
    const isPremium = currentFeature.type === 'premium';

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
            <div className="relative z-10 flex flex-col items-center h-full w-full px-6 py-6 text-center">

                {/* Ambient Glow for Premium Slide */}
                <AnimatePresence>
                    {currentFeature.type === 'premium' && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.8 }}
                            className="absolute inset-0 z-[-1] flex items-center justify-center pointer-events-none"
                        >
                            <div
                                className="w-[200px] h-[200px] rounded-full blur-[60px]"
                                style={{
                                    background: 'radial-gradient(circle, rgba(255, 215, 0, 0.15) 0%, rgba(255, 215, 0, 0) 70%)',
                                }}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>

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
                        {/* Eyebrow / Label */}
                        {currentFeature.eyebrow && (
                            <div className="mb-2 text-[11px] font-semibold tracking-[0.15em] text-yellow-500/80 uppercase">
                                {currentFeature.eyebrow}
                            </div>
                        )}

                        {/* Content Stack: Dimensions Matched to Standard Slide */}
                        <div className="relative h-full w-full flex flex-col items-center justify-center">

                            {/* Main Content Group */}
                            <div className="flex flex-col items-center justify-center translate-y-2"> {/* Adjusted down per user request */}

                                {/* Title */}
                                <h2
                                    className="text-white drop-shadow-sm tracking-tight mb-1"
                                    style={{
                                        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text"',
                                        fontSize: isPremium ? '30px' : '26px', // Increased by ~15% (26 -> 30)
                                        fontWeight: isPremium ? 600 : 500,
                                        lineHeight: 1.1,
                                        ...(isPremium ? {
                                            backgroundImage: 'linear-gradient(180deg, #FFE8A3 0%, #D4AF37 100%)',
                                            WebkitBackgroundClip: 'text',
                                            WebkitTextFillColor: 'transparent',
                                            textShadow: '0 2px 14px rgba(212, 175, 55, 0.25)',
                                        } : {})
                                    }}
                                >
                                    {currentFeature.headline}
                                </h2>

                                {/* Subtitle */}
                                <p
                                    className="antialiased opacity-90 mb-3" // Reduced margin (was mb-5)
                                    style={{
                                        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text"',
                                        fontSize: isPremium ? '16px' : '15px', // Increased by ~15% (14 -> 16)
                                        fontWeight: 400,
                                        lineHeight: 1.3, // Slightly tighter line height
                                        color: isPremium ? '#F5F5F7' : 'rgba(255,255,255,0.75)',
                                        maxWidth: '360px'
                                    }}
                                >
                                    {currentFeature.subtitle}
                                </p>

                                {/* Bullets - Replacing Button Area */}
                                {currentFeature.bullets && (
                                    <div className="flex flex-col gap-1 w-full max-w-[340px]">
                                        {currentFeature.bullets.map((bullet, idx) => (
                                            <div key={idx} className="flex items-center justify-center gap-2 px-2">
                                                <div className="flex-shrink-0 flex items-center justify-center">
                                                    <Check size={12} className="text-[#FFD700]" strokeWidth={2.5} />
                                                </div>
                                                <span
                                                    className="text-[12.5px] text-white/95 leading-snug" // Slightly smaller to fit
                                                    style={{ letterSpacing: '-0.01em' }}
                                                >
                                                    {bullet}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Footer: Absolutely Positioned (Zero Height Impact) */}
                            {currentFeature.footer && (
                                <div className="absolute -bottom-10 w-full text-center pointer-events-none">
                                    <p className="text-[11px] text-white/8 font-medium tracking-wide">
                                        {currentFeature.footer}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Primary Action Button - Hidden for Premium slide */}
                        {!isPremium && (
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
                        )}
                    </motion.div>
                </AnimatePresence>

            </div>
        </div>
    );
};
