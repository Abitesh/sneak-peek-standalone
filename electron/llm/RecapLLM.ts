// electron/llm/RecapLLM.ts
// MODE: Recap - Neutral conversation summary
// Summarizes conversation in bullet points, no advice or opinions
// Uses Groq first with Gemini fallback

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MODE_CONFIGS } from "./types";
import { GROQ_RECAP_PROMPT, buildRecapContents } from "./prompts";
import { clampResponse } from "./postProcessor";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export class RecapLLM {
    private client: GoogleGenAI;
    private groqClient: Groq | null = null;
    private modelName: string;
    private config = MODE_CONFIGS.recap;

    constructor(client: GoogleGenAI, modelName: string, groqClient?: Groq | null) {
        this.client = client;
        this.modelName = modelName;
        if (groqClient) {
            this.groqClient = groqClient;
        }
    }

    /**
     * Generate a neutral conversation summary
     * @param context - Full conversation to summarize
     * @returns Bullet-point summary (3-5 points)
     */
    async generate(context: string): Promise<string> {
        try {
            if (!context.trim()) {
                return "";
            }

            const contents = buildRecapContents(context);

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

            // Recap allows bullets and more words, but still clamped
            // Don't strip bullets for recap, just limit length
            return clampRecapResponse(rawText);

        } catch (error) {
            console.error("[RecapLLM] Generation failed:", error);
            return "";
        }
    }

    /**
     * Generate a neutral conversation summary (Streamed)
     * Uses Groq first if available, falls back to Gemini
     */
    async *generateStream(context: string): AsyncGenerator<string> {
        try {
            if (!context.trim()) {
                yield "";
                return;
            }

            // Try Groq first if available
            if (this.groqClient) {
                try {
                    console.log(`[RecapLLM] 🚀 Using Groq (${GROQ_MODEL})...`);
                    const groqMessage = `${GROQ_RECAP_PROMPT}\n\nCONVERSATION:\n${context}`;

                    const stream = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        stream: true,
                        temperature: 0.2,
                        max_tokens: 1024,
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
                        console.log(`[RecapLLM] ✅ Groq stream completed`);
                        return; // Success - done
                    }
                } catch (err: any) {
                    console.warn(`[RecapLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini
            const contents = buildRecapContents(context);

            console.log(`[RecapLLM] 🔄 Using Gemini fallback (${this.modelName})...`);

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
            // Note: We cannot easily clamp streaming response content (max 5 bullets) in real-time without buffering.
            // For now, we rely on the prompt to be concise, or we let the UI clamp it.
            // The prompt "Summarize in 3-5 bullet points" is usually strong enough.

        } catch (error) {
            console.error("[RecapLLM] Streaming generation failed:", error);
            yield "";
        }
    }
}

/**
 * Special clamp for recap - allows bullets, limits to 5 points
 */
function clampRecapResponse(text: string): string {
    if (!text || typeof text !== "string") {
        return "";
    }

    let result = text.trim();

    // Remove headers only (Recap should just be bullets)
    // result = result.replace(/^#{1,6}\s+/gm, ""); 
    // Actually, maybe keep headers if the model uses them for sectioning? 
    // But Recap prompt asks for bullets. Let's keep it simple and just limit lines.

    // Split by newlines
    const lines = result.split(/\n/).filter(line => line.trim());

    // Take at most 5 non-empty lines (usually bullets)
    // This assumes the model follows instructions reasonably well.
    const clamped = lines.slice(0, 5);

    return clamped.join("\n").trim();
}
