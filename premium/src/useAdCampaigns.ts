import { useState, useEffect } from 'react';

export interface RemoteCampaign {
    id: string;
    type?: string;
    title: string;
    message: string;
    cta_text: string;
    url?: string;
    icon: 'sparkles' | 'alert' | 'info';
    targeting?: {
        requires_premium?: boolean;
        os?: 'mac' | 'all';
        max_version?: string;
    };
    expires_at?: string;
    priority?: number;
}

type LocalAdCampaign = 'promo' | 'profile' | 'jd';
export type AdCampaign = LocalAdCampaign | RemoteCampaign | null;

const REMOTE_CONFIG_URL = 'https://campaign-sand.vercel.app/campaigns.json';

// Helper to compare semantic versions safely (e.g. "2.0.1" <= "2.1.0")
const isVersionLessThanOrEqual = (current: string, max: string): boolean => {
    const v1 = current.split('.').map(Number);
    const v2 = max.split('.').map(Number);
    for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
        const n1 = v1[i] || 0;
        const n2 = v2[i] || 0;
        if (n1 > n2) return false;
        if (n1 < n2) return true;
    }
    return true; // Exactly equal
};

export const useAdCampaigns = (
  isPremium: boolean,
  hasProfile: boolean,
  isAppReady: boolean, // True when launcher is visible and steady
  appStartTime: number,
  lastMeetingEndTime: number | null,
  isProcessingMeeting: boolean
) => {
    const [activeAd, setActiveAd] = useState<AdCampaign>(null);
    const [isInactive, setIsInactive] = useState(false);
    const [pendingAd, setPendingAd] = useState<{ ad: AdCampaign, id: string, readyAt: number } | null>(null);

    // 1. Track Inactivity
    useEffect(() => {
        const isOverlayWindow = new URLSearchParams(window.location.search).get('window') === 'overlay';
        if (!isAppReady || isOverlayWindow || isProcessingMeeting) return;

        let inactivityTimer: ReturnType<typeof setTimeout>;
        const resetInactivity = () => {
            setIsInactive(false);
            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => setIsInactive(true), 5000);
        };

        resetInactivity();
        const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];
        events.forEach(e => window.addEventListener(e, resetInactivity));

        return () => {
            clearTimeout(inactivityTimer);
            events.forEach(e => window.removeEventListener(e, resetInactivity));
        };
    }, [isAppReady, isProcessingMeeting]);

    // 2. Fetch and Queue Campaigns
    useEffect(() => {
        // Enforce trigger only when the app reaches an "idle/ready" state (e.g. Launcher is visible)
        // so it doesn't pop up over modals or during meeting.
        // We also check for overlay window explicitly.
        const isOverlayWindow = new URLSearchParams(window.location.search).get('window') === 'overlay';
        if (!isAppReady || isOverlayWindow || isProcessingMeeting) {
            // Dismiss active ad gracefully if they navigate away
            if (activeAd) {
                setActiveAd(null);
            }
            // Clear pending ad
            if (pendingAd) {
                setPendingAd(null);
            }
            return;
        }

        let isMounted = true;

        const checkCampaigns = async () => {
            // 1. Enforce Global Cooldown System
            // We only want to show ONE notification toaster every X hours to avoid annoying the user.
            const lastAdStr = localStorage.getItem('natively_last_ad_shown_time');
            const now = Date.now();
            const cooldownHours = 4; // 4 hours between ANY ad
            
            if (lastAdStr) {
                const lastAdTime = parseInt(lastAdStr, 10);
                const hoursSinceLastAd = (now - lastAdTime) / (1000 * 60 * 60);
                
                // In DEV mode, we skip the cooldown so you can test it easily.
                // In PROD, it stops the script here if the cooldown hasn't passed.
                if (hoursSinceLastAd < cooldownHours && !import.meta.env.DEV) {
                    console.log(`[AdCampaigns] Cooldown active. Last ad was ${hoursSinceLastAd.toFixed(1)}h ago.`);
                    return;
                }
            }

            // 2. Fetch Remote Campaigns (Fast, silent fail)
            let remoteCampaigns: RemoteCampaign[] = [];
            try {
                const controller = new AbortController();
                const fetchTimeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
                
                const res = await fetch(REMOTE_CONFIG_URL, { signal: controller.signal });
                clearTimeout(fetchTimeout);
                
                if (res.ok) {
                    const data = await res.json();
                    
                    // Filter valid campaigns based on targeting
                    remoteCampaigns = (data.active_campaigns || []).filter((c: any) => {
                        // Safe date paring checks
                        if (!c.expires_at || isNaN(Date.parse(c.expires_at))) return false;
                        if (new Date(c.expires_at) < new Date()) return false;
                        
                        // Targeting booleans
                        if (c.targeting?.requires_premium === false && isPremium) return false;
                        if (c.targeting?.requires_premium === true && !isPremium) return false;
                        
                        // Targeting OS parsing - Assuming the native desktop app is current Mac
                        if (c.targeting?.os && c.targeting.os !== 'all' && c.targeting.os !== 'mac') return false; 
                        
                        // App Version Targeting Check
                        if (c.targeting?.max_version) {
                            // Fetch target app version from Vite env, fallback to '2.0.1' safely
                            const CURRENT_APP_VERSION = import.meta.env.VITE_APP_VERSION || '2.0.1';
                            if (!isVersionLessThanOrEqual(CURRENT_APP_VERSION, c.targeting.max_version)) {
                                return false; // Current version exceeds max allowed version
                            }
                        }

                        // Check if user already dismissed this specific remote campaign ID
                        const dismissedIds = JSON.parse(localStorage.getItem('natively_dismissed_campaigns') || '[]');
                        if (dismissedIds.includes(c.id)) return false;

                        return true;
                    });
                }
            } catch (e) {
                console.warn("[AdCampaigns] Remote fetch failed, falling back to local.");
            }

            if (!isMounted) return;

            // 3. Determine what to show
            // Gather all eligible candidates (Remote + Local)
            let candidates: { ad: AdCampaign, id: string, priority: number }[] = [];

            // Add Remote Campaigns
            remoteCampaigns.forEach(c => {
                candidates.push({ ad: c as AdCampaign, id: c.id, priority: c.priority || 0 });
            });

            // Gather Local Campaigns
            const isAdEligible = (key: string) => {
                const val = localStorage.getItem(key);
                if (!val) return true; // Never dismissed
                
                // Legacy support for older users who have 'true' stored
                if (val === 'true') {
                    return false; 
                }

                const dismissedTime = parseInt(val, 10);
                if (isNaN(dismissedTime)) return true;

                const daysSinceDismissal = (now - dismissedTime) / (1000 * 60 * 60 * 24);
                const cooldownDays = import.meta.env.DEV ? 0 : 7; 

                return daysSinceDismissal >= cooldownDays;
            };

            const localEligible: LocalAdCampaign[] = [];
            
            if (!isPremium && isAdEligible('natively_promo_toaster_dismissed')) {
                localEligible.push('promo');
            }
            
            if (!hasProfile && isAdEligible('natively_profile_toaster_dismissed')) {
                localEligible.push('profile');
            }

            // If they have a profile, but no JD uploaded, promote JD awareness
            if (hasProfile && isAdEligible('natively_jd_toaster_dismissed')) {
                localEligible.push('jd');
            }

            localEligible.forEach(l => {
                // Local ads typically have a baseline priority of 0, whereas remote ads might be weighted higher
                candidates.push({ ad: l, id: l, priority: 0 });
            });

            if (candidates.length === 0) return;

            // 4. Implement Queue / History Logic
            let history: string[] = JSON.parse(localStorage.getItem('natively_ads_shown_history') || '[]');
            let availableCandidates = candidates.filter(c => !history.includes(c.id));

            if (availableCandidates.length === 0) {
                // Reset history if all ads have been shown
                history = [];
                localStorage.setItem('natively_ads_shown_history', JSON.stringify(history));
                availableCandidates = candidates;
            }

            // Group by highest priority
            availableCandidates.sort((a, b) => b.priority - a.priority);
            const topPriority = availableCandidates[0].priority;
            const topCandidates = availableCandidates.filter(c => c.priority === topPriority);
            
            // Randomly select one from the highest priority grouping
            const selectedCandidate = topCandidates[Math.floor(Math.random() * topCandidates.length)];

            // 5. Trigger with Dynamic Delay
            // User requested: 10 seconds after app opens, OR 6 seconds after a meeting ends.
            let delayToUse = 1500; // Fallback
            
            const nowTime = Date.now();
            if (lastMeetingEndTime && nowTime - lastMeetingEndTime < 15000) {
                // If a meeting just ended in the last 15 seconds, use 6 second delay from that end time
                const timeSinceMeetingEnd = nowTime - lastMeetingEndTime;
                delayToUse = Math.max(0, 6000 - timeSinceMeetingEnd);
            } else {
                // Otherwise this is likely an app startup flow. Wait 10 seconds from the App mount time.
                const timeSinceAppStart = nowTime - appStartTime;
                delayToUse = Math.max(0, 10000 - timeSinceAppStart);
            }

            if (!isMounted) return;
            setPendingAd({ ad: selectedCandidate.ad, id: selectedCandidate.id, readyAt: nowTime + delayToUse });
        };

        // Delay checking to prevent immediate spamming if the user navigates back and forth quickly
        const fetchTimer = setTimeout(() => {
            checkCampaigns();
        }, 500);

        return () => {
            isMounted = false;
            clearTimeout(fetchTimer);
        };

    }, [isAppReady, isPremium, hasProfile, appStartTime, lastMeetingEndTime, isProcessingMeeting, activeAd, pendingAd]);

    // 6. Show Ad when Inactive and Ready
    useEffect(() => {
        if (!pendingAd || activeAd) return;

        const checkAndShow = () => {
            if (Date.now() >= pendingAd.readyAt && isInactive) {
                setActiveAd(pendingAd.ad);
                
                // Track cooldown & history
                localStorage.setItem('natively_last_ad_shown_time', Date.now().toString());
                const history = JSON.parse(localStorage.getItem('natively_ads_shown_history') || '[]');
                if (!history.includes(pendingAd.id)) {
                    history.push(pendingAd.id);
                    localStorage.setItem('natively_ads_shown_history', JSON.stringify(history));
                }
                
                setPendingAd(null);
            }
        };

        const remainingTime = pendingAd.readyAt - Date.now();
        let timer: ReturnType<typeof setTimeout>;

        // We check once immediately, or wait until the ready time.
        // It will also re-run whenever `isInactive` flips to true, which is exactly what we want.
        if (remainingTime > 0) {
            timer = setTimeout(checkAndShow, remainingTime);
        } else {
            checkAndShow();
        }

        return () => clearTimeout(timer);
    }, [pendingAd, isInactive, activeAd]);

    const dismissAd = (campaignId?: string) => {
        if (campaignId) {
            // Track dismissed remote campaigns so they never show again
            const dismissed: string[] = JSON.parse(localStorage.getItem('natively_dismissed_campaigns') || '[]');
            dismissed.push(campaignId);
            localStorage.setItem('natively_dismissed_campaigns', JSON.stringify(dismissed));
            
            // Also enforce local dismissal depending on what was closed if needed
            // The existing tool handled this via specific handlers like natively_promo_toaster_dismissed
        }
        setActiveAd(null);
    };

    // Dev Override Shortcut (Ctrl/Cmd + Shift + A)
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        
        const handleKeyDown = async (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                console.log("[AdCampaigns] Manual trigger activated via shortcut.");
                
                try {
                    const res = await fetch(REMOTE_CONFIG_URL);
                    console.log("[AdCampaigns] fetch status:", res.status);
                    if (res.ok) {
                        const data = await res.json();
                        console.log("[AdCampaigns] fetch data:", data);
                        if (data.active_campaigns && data.active_campaigns.length > 0) {
                            console.log("[AdCampaigns] setting active ad:", data.active_campaigns[0]);
                            setActiveAd(data.active_campaigns[0]);
                        } else {
                            console.log("[AdCampaigns] no active campaigns found in payload");
                        }
                    }
                } catch (err) {
                    console.error("[AdCampaigns] Manual fetch failed", err);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return { activeAd, dismissAd };
};
