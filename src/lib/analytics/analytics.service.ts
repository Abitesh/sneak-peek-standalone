import ReactGA from "react-ga4";

// --- Types ---

export type ModelProviderType = 'cloud' | 'local';

export type AssistantMode = 'launcher' | 'overlay' | 'undetectable';

export type AnalyticsEventName =
    // App Lifecycle
    | 'app_opened'
    | 'app_closed'
    | 'first_launch'
    // Feature Usage
    | 'assistant_started'
    | 'assistant_stopped'
    | 'mode_selected'
    | 'copy_answer_clicked'
    // Model Usage
    | 'model_used'
    // Session
    | 'session_duration'
    // Engagement
    | 'command_executed'
    | 'conversation_started';

interface ModelUsedPayload {
    model_name: string;
    provider_type: ModelProviderType;
    latency_ms: number;
    tokens_used?: number;
}

interface SessionDurationPayload {
    duration_seconds: number;
    assistant_active_seconds?: number;
    idle_seconds?: number;
}

// --- Service ---

class AnalyticsService {
    private static instance: AnalyticsService;
    private initialized = false;
    private sessionStartTime: number = Date.now();
    private assistantStartTime: number | null = null;
    private totalAssistantDuration: number = 0;

    private constructor() { }

    public static getInstance(): AnalyticsService {
        if (!AnalyticsService.instance) {
            AnalyticsService.instance = new AnalyticsService();
        }
        return AnalyticsService.instance;
    }

    public initAnalytics(measurementId: string = "G-494RMJ2G6E"): void {
        if (this.initialized) return;

        // Initialize GA4
        ReactGA.initialize(measurementId, {
            gaOptions: {
                anonymizeIp: true, // Privacy compliant
                userId: undefined, // No user tracking
            },
        });

        this.initialized = true;
        console.log("[Analytics] Initialized with privacy mode enabled.");
    }

    // --- Tracking Methods ---

    public trackAppOpen(): void {
        if (!this.initialized) return;

        this.trackEvent('app_opened');

        // Check for first launch
        const hasLaunched = localStorage.getItem('natively_has_launched');
        if (!hasLaunched) {
            this.trackEvent('first_launch');
            localStorage.setItem('natively_has_launched', 'true');
        }
    }

    public trackAppClose(): void {
        if (!this.initialized) return;

        this.trackSessionDuration();
        this.trackEvent('app_closed');
    }

    public trackAssistantStart(): void {
        if (!this.initialized) return;

        this.assistantStartTime = Date.now();
        this.trackEvent('assistant_started');
    }

    public trackAssistantStop(): void {
        if (!this.initialized) return;

        if (this.assistantStartTime) {
            const duration = (Date.now() - this.assistantStartTime) / 1000;
            this.totalAssistantDuration += duration;
            this.assistantStartTime = null;
        }
        this.trackEvent('assistant_stopped');
    }

    public trackModeSelected(mode: AssistantMode): void {
        if (!this.initialized) return;

        this.trackEvent('mode_selected', { mode });
    }

    public trackModelUsed(payload: ModelUsedPayload): void {
        if (!this.initialized) return;

        this.trackEvent('model_used', payload);
    }

    public trackCopyAnswer(): void {
        if (!this.initialized) return;
        this.trackEvent('copy_answer_clicked');
    }

    public trackCommandExecuted(commandType: string): void {
        if (!this.initialized) return;
        this.trackEvent('command_executed', { command_type: commandType });
    }

    public trackConversationStarted(): void {
        if (!this.initialized) return;
        this.trackEvent('conversation_started');
    }


    private trackSessionDuration(): void {
        const totalDuration = (Date.now() - this.sessionStartTime) / 1000;

        // If assistant is currently active, add current session to total
        let currentAssistantDuration = this.totalAssistantDuration;
        if (this.assistantStartTime) {
            currentAssistantDuration += (Date.now() - this.assistantStartTime) / 1000;
        }

        const payload: SessionDurationPayload = {
            duration_seconds: Math.round(totalDuration),
            assistant_active_seconds: Math.round(currentAssistantDuration),
            idle_seconds: Math.round(totalDuration - currentAssistantDuration)
        };

        this.trackEvent('session_duration', payload);
    }

    // --- Core Event Sender ---

    private trackEvent(eventName: AnalyticsEventName, payload?: Record<string, any>): void {
        try {
            // Log to console in dev mode
            if (import.meta.env.DEV) {
                console.log(`[Analytics] ${eventName}`, payload);
            }

            ReactGA.event(eventName, payload || {});
        } catch (error) {
            console.warn("[Analytics] Failed to send event:", error);
        }
    }
}

export const analytics = AnalyticsService.getInstance();
