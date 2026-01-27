import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';

const UpdateBanner: React.FC = () => {
    const [updateInfo, setUpdateInfo] = useState<any>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        // Listen for update-downloaded event
        const unsubscribe = window.electronAPI.onUpdateDownloaded((info) => {
            console.log('[UpdateBanner] Update ready:', info);
            setUpdateInfo(info);
            setIsVisible(true);
        });

        return () => unsubscribe();
    }, []);

    // Demo mode: Press Cmd+Shift+U to show the banner
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'u') {
                e.preventDefault();
                setUpdateInfo({ version: '1.0.2' });
                setIsVisible(true);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const handleRestart = () => {
        window.electronAPI.restartAndInstall();
    };

    const handleDismiss = () => {
        setIsVisible(false);
    };

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 10, filter: "blur(10px)" }}
                        animate={{ opacity: 1, scale: 1, y: 0, filter: "none" }}
                        exit={{ opacity: 0, scale: 0.95, y: 10, filter: "blur(10px)" }}
                        transition={{ type: 'spring', damping: 30, stiffness: 400, mass: 1 }}
                        className="w-full max-w-[340px] mx-4"
                    >
                        <div className="relative bg-[#1e1e1eba] backdrop-filter backdrop-blur-xl saturate-[180%] border border-[#ffffff1a] rounded-[20px] shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_0_1px_rgba(0,0,0,0.2)] overflow-hidden">
                            <div className="p-6 flex flex-col items-center text-center">
                                {/* Subtle Icon */}
                                <div className="mb-4 text-[#ffffffcc] opacity-90">
                                    <RefreshCw size={26} strokeWidth={2} />
                                </div>

                                {/* Typography: Calm, sentence-case, confident */}
                                <h3 className="text-[17px] font-semibold text-[#ffffffe6] mb-1 tracking-tight">
                                    Update ready
                                </h3>
                                <p className="text-[13px] text-[#ffffff8a] leading-relaxed mb-6 font-medium">
                                    A new version of Natively is ready to install.<br />
                                    Restart now to finish updating.
                                </p>

                                {/* Buttons: Horizontal, balanced, native feel */}
                                <div className="flex w-full gap-3">
                                    <button
                                        onClick={handleDismiss}
                                        className="flex-1 py-[6px] text-[13px] font-medium text-[#ffffff99] hover:text-white hover:bg-[#ffffff10] rounded-[8px] transition-all duration-200"
                                    >
                                        Not now
                                    </button>

                                    <button
                                        onClick={handleRestart}
                                        className="flex-1 py-[6px] bg-[#0091FF]/70 hover:bg-[#0091FF] active:scale-[0.98] text-[13px] font-medium text-white rounded-[8px] transition-all duration-200 shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
                                    >
                                        Restart
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default UpdateBanner;
