import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface RollingTranscriptProps {
    text: string;
}

const RollingTranscript: React.FC<RollingTranscriptProps> = ({ text }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to the end when text updates
    useEffect(() => {
        if (containerRef.current) {
            containerRef.current.scrollLeft = containerRef.current.scrollWidth;
        }
    }, [text]);

    if (!text) return null;

    return (
        <div className="relative w-full max-w-[700px] mx-auto px-4 group">
            {/* Left Gradient Mask */}
            <div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-[#1E1E1E] to-transparent z-20 pointer-events-none" />

            {/* Right Gradient Mask */}
            <div className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-[#1E1E1E] to-transparent z-20 pointer-events-none" />

            {/* Scrolling Container */}
            <div
                ref={containerRef}
                className="overflow-hidden whitespace-nowrap text-right scroll-smooth"
                style={{
                    maskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)'
                }}
            >
                <div
                    ref={textRef}
                    className="inline-block text-[14px] font-medium text-slate-300/50 leading-relaxed transition-all duration-300"
                >
                    {text}
                </div>
            </div>
        </div>
    );
};

export default RollingTranscript;
