// electron/llm/AssistLLM.ts
// MODE: Assist - Passive observation (low priority)
// Provides brief observational insights, NEVER suggests what to say

import { GoogleGenAI } from "@google/genai";
import { MODE_CONFIGS } from "./types";
import { ASSIST_MODE_PROMPT, buildContents } from "./prompts";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";

export class AssistLLM {
    private client: GoogleGenAI;
    private modelName: string;
    private config = MODE_CONFIGS.assist;

    constructor(client: GoogleGenAI, modelName: string) {
        this.client = client;
        this.modelName = modelName;
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
