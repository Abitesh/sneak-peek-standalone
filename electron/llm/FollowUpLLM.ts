// electron/llm/FollowUpLLM.ts
// MODE: Follow-Up - Refinement of last answer
// Modifies previous answer based on user request (shorter, longer, rephrase, etc.)

import { GoogleGenAI } from "@google/genai";
import { MODE_CONFIGS } from "./types";
import { buildFollowUpContents } from "./prompts";
import { clampResponse } from "./postProcessor";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";

export class FollowUpLLM {
    private client: GoogleGenAI;
    private modelName: string;
    private config = MODE_CONFIGS.followUp;

    constructor(client: GoogleGenAI, modelName: string) {
        this.client = client;
        this.modelName = modelName;
    }

    /**
     * Refine a previous answer based on user request
     * @param previousAnswer - The last assistant-generated answer
     * @param refinementRequest - What the user wants changed (e.g., "make it shorter")
     * @param context - Optional conversation context for tone
     * @returns Refined spoken answer
     */
    async generate(
        previousAnswer: string,
        refinementRequest: string,
        context?: string
    ): Promise<string> {
        try {
            if (!previousAnswer.trim()) {
                return "";
            }

            const contents = buildFollowUpContents(
                previousAnswer,
                refinementRequest,
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

            // Return without clamping
            return rawText;

        } catch (error) {
            console.error("[FollowUpLLM] Generation failed:", error);
            return "";
        }
    }

    /**
     * Refine a previous answer based on user request (Streamed)
     */
    async *generateStream(
        previousAnswer: string,
        refinementRequest: string,
        context?: string
    ): AsyncGenerator<string> {
        try {
            if (!previousAnswer.trim()) {
                yield "";
                return;
            }

            const contents = buildFollowUpContents(
                previousAnswer,
                refinementRequest,
                context
            );

            console.log(`[FollowUpLLM] Starting stream with model: ${this.modelName}`);

            const streamResult = await this.client.models.generateContentStream({
                model: this.modelName,
                contents: contents,
                config: {
                    maxOutputTokens: this.config.maxOutputTokens,
                    temperature: this.config.temperature,
                    topP: this.config.topP,
                },
            });

            // @ts-ignore
            const stream = streamResult.stream || streamResult;

            for await (const chunk of stream) {
                let text = "";
                // Robust handling
                if (typeof chunk.text === 'function') {
                    text = chunk.text();
                } else if (typeof chunk.text === 'string') {
                    text = chunk.text;
                } else if (chunk.candidates?.[0]?.content?.parts?.[0]?.text) {
                    text = chunk.candidates[0].content.parts[0].text;
                }

                if (text) {
                    yield text;
                }
            }

        } catch (error) {
            console.error("[FollowUpLLM] Streaming generation failed:", error);
            yield "";
        }
    }
}
