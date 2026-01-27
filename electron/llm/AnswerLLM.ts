// electron/llm/AnswerLLM.ts
// MODE: "What should I say" - Primary auto-answer for interviews
// Generates ready-to-speak first-person responses

import { GoogleGenAI } from "@google/genai";
import { MODE_CONFIGS } from "./types";
import { ANSWER_MODE_PROMPT, buildContents } from "./prompts";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";

export class AnswerLLM {
    private client: GoogleGenAI;
    private modelName: string;
    private config = MODE_CONFIGS.answer;

    constructor(client: GoogleGenAI, modelName: string) {
        this.client = client;
        this.modelName = modelName;
    }

    /**
     * Generate a spoken interview answer
     * @param question - The interviewer's question
     * @param context - Optional conversation context
     * @returns Spoken answer (no post-clamp; prompt enforces brevity)
     */
    async generate(question: string, context?: string): Promise<string> {
        try {
            const contents = buildContents(ANSWER_MODE_PROMPT, question, context);

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
            // Silent failure - return empty for safety
            console.error("[AnswerLLM] Generation failed:", error);
            return "";
        }
    }
}
