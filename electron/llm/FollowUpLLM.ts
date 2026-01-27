// electron/llm/FollowUpLLM.ts
// MODE: Follow-Up - Refinement of last answer
// Modifies previous answer based on user request (shorter, longer, rephrase, etc.)
// Uses Groq first with Gemini fallback

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MODE_CONFIGS } from "./types";
import { GROQ_FOLLOWUP_PROMPT, buildFollowUpContents } from "./prompts";
import { clampResponse } from "./postProcessor";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export class FollowUpLLM {
    private client: GoogleGenAI;
    private groqClient: Groq | null = null;
    private modelName: string;
    private config = MODE_CONFIGS.followUp;

    constructor(client: GoogleGenAI, modelName: string, groqClient?: Groq | null) {
        this.client = client;
        this.modelName = modelName;
        if (groqClient) {
            this.groqClient = groqClient;
        }
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
     * Uses Groq first if available, falls back to Gemini
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

            // Try Groq first if available
            if (this.groqClient) {
                try {
                    console.log(`[FollowUpLLM] 🚀 Using Groq (${GROQ_MODEL})...`);
                    const groqMessage = `${GROQ_FOLLOWUP_PROMPT}

PREVIOUS ANSWER:
${previousAnswer}

REFINEMENT REQUEST: ${refinementRequest}

REFINED ANSWER:`;

                    const stream = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        stream: true,
                        temperature: 0.3,
                        max_tokens: 2048,
                    });

                    let hasContent = false;
                    for await (const chunk of stream) {
                        const content = chunk.choices[0]?.delta?.content;
                        if (content) {
                            hasContent = true;
                            yield content;
                        }
                    }

                    if (hasContent) {
                        console.log(`[FollowUpLLM] ✅ Groq stream completed`);
                        return; // Success - done
                    }
                } catch (err: any) {
                    console.warn(`[FollowUpLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini
            const contents = buildFollowUpContents(
                previousAnswer,
                refinementRequest,
                context
            );

            console.log(`[FollowUpLLM] 🔄 Using Gemini fallback (${this.modelName})...`);

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
