// electron/llm/AssistLLM.ts
// MODE: Assist - Passive observation (low priority)
// Provides brief observational insights, NEVER suggests what to say
// Uses Groq first with Gemini fallback

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MODE_CONFIGS } from "./types";
import { ASSIST_MODE_PROMPT, buildContents } from "./prompts";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export class AssistLLM {
    private client: GoogleGenAI;
    private groqClient: Groq | null = null;
    private modelName: string;
    private config = MODE_CONFIGS.assist;

    constructor(client: GoogleGenAI, modelName: string, groqClient?: Groq | null) {
        this.client = client;
        this.modelName = modelName;
        if (groqClient) {
            this.groqClient = groqClient;
        }
    }

    /**
     * Generate passive observational insight
     * @param context - Current conversation context
     * @returns Insight (no post-clamp; prompt enforces brevity)
     */
    async generate(context: string): Promise<string> {
        try {
            if (!context.trim()) {
                return "";
            }

            // Try Groq first if available
            if (this.groqClient) {
                try {
                    // Assist mode is passive, so use a simple observational prompt
                    // We don't necessarily need the full interview persona here, but we'll use a high-performance model
                    const groqMessage = `You are an expert interview coach observing this interaction.
Briefly summarize what is happening right now in 1-2 sentences. Do not give advice, just observation.

CONTEXT:
${context}`;

                    const completion = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        temperature: 0.3,
                        max_tokens: 128,
                    });

                    const content = completion.choices[0]?.message?.content;
                    if (content) {
                        return content.trim();
                    }
                } catch (err: any) {
                    console.warn(`[AssistLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini
            const contents = buildContents(
                ASSIST_MODE_PROMPT,
                "What's happening in this conversation right now?",
                context
            );

            const response = await this.client.models.generateContent({
                model: this.modelName,
                contents: contents,
                config: {
                    maxOutputTokens: this.config.maxOutputTokens,
                    temperature: this.config.temperature,
                    topP: this.config.topP,
                },
            });

            // Extract text handling potential missing top-level text property
            const rawText = response.text
                || response.candidates?.[0]?.content?.parts?.[0]?.text
                || "";

            return rawText.trim();

        } catch (error) {
            console.error("[AssistLLM] Generation failed:", error);
            return "";
        }
    }
}
