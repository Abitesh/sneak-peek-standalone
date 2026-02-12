/**
 * Speech-to-Text Provider Constants
 * Configuration for REST-based STT providers (Groq, OpenAI Whisper, Deepgram)
 */

export type SttProviderId = 'google' | 'groq' | 'openai' | 'deepgram';

export interface SttProviderConfig {
    id: SttProviderId;
    name: string;
    description: string;
    endpoint: string;
    model: string;
    /** Available models for this provider (for user selection) */
    availableModels?: { id: string; label: string }[];
    /** Upload type: 'multipart' for FormData (Groq/OpenAI), 'binary' for raw body (Deepgram) */
    uploadType?: 'multipart' | 'binary';
    authHeader: (apiKey: string) => Record<string, string>;
    /** Path to extract transcript text from the JSON response */
    responseContentPath: string;
    /** Extra form fields to include in the multipart upload */
    extraFormFields?: Record<string, string>;
}

export const STT_PROVIDERS: Record<SttProviderId, SttProviderConfig> = {
    google: {
        id: 'google',
        name: 'Google Cloud (Default)',
        description: 'Uses gRPC streaming via Google Cloud Service Account',
        endpoint: '', // Google uses gRPC, not REST
        model: '',
        authHeader: () => ({}),
        responseContentPath: '',
    },
    groq: {
        id: 'groq',
        name: 'Groq Whisper (Fast)',
        description: 'Ultra-fast transcription via Groq API',
        endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
        model: 'whisper-large-v3-turbo',
        uploadType: 'multipart',
        availableModels: [
            { id: 'whisper-large-v3-turbo', label: 'Whisper Large V3 Turbo (Fastest)' },
            { id: 'whisper-large-v3', label: 'Whisper Large V3 (Most Accurate)' },
        ],
        authHeader: (apiKey: string) => ({
            Authorization: `Bearer ${apiKey}`,
        }),
        responseContentPath: 'text',
        extraFormFields: {
            temperature: '0',
            response_format: 'json',
            language: 'en',
        },
    },
    openai: {
        id: 'openai',
        name: 'OpenAI Whisper',
        description: 'Transcription via OpenAI Whisper API',
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'whisper-1',
        uploadType: 'multipart',
        authHeader: (apiKey: string) => ({
            Authorization: `Bearer ${apiKey}`,
        }),
        responseContentPath: 'text',
    },
    deepgram: {
        id: 'deepgram',
        name: 'Deepgram Nova-2',
        description: 'Accurate transcription via Deepgram API',
        endpoint: 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
        model: 'nova-2',
        uploadType: 'binary',
        authHeader: (apiKey: string) => ({
            Authorization: `Token ${apiKey}`,
        }),
        responseContentPath: 'results.channels[0].alternatives[0].transcript',
    },
};

export const STT_PROVIDER_OPTIONS = Object.values(STT_PROVIDERS);

export const DEFAULT_STT_PROVIDER: SttProviderId = 'google';

