// electron/llm/WhatToAnswerLLM.ts
// MODE: "What to Answer" - Manual trigger for interview copilot
// Single-pass question inference + answer generation
// NEVER returns empty - always provides a usable response

import { GoogleGenAI } from "@google/genai";
import { WHAT_TO_ANSWER_PROMPT, buildWhatToAnswerContents } from "./prompts";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";

export class WhatToAnswerLLM {
    private client: GoogleGenAI;
    private modelName: string;

    constructor(client: GoogleGenAI, modelName: string = GEMINI_FLASH_MODEL) {
        this.client = client;
        this.modelName = modelName;
    }

    /**
     * Generate a spoken interview answer from transcript context
     * Performs BOTH question inference AND answer generation in one call
     * 
     * @param cleanedTranscript - Pre-processed transcript (cleaned + sparsified)
     * @returns Ready-to-speak answer, NEVER empty
     */
    /**
     * Generate a spoken interview answer from transcript context (Streamed)
     */
    async *generateStream(cleanedTranscript: string): AsyncGenerator<string> {
        try {
            // Handle empty/thin transcript gracefully
            if (!cleanedTranscript || cleanedTranscript.trim().length < 10) {
                const fallback = this.getFallbackAnswer();
                yield fallback;
                return;
            }

            const contents = buildWhatToAnswerContents(cleanedTranscript);

            const streamResult = await this.client.models.generateContentStream({
                model: this.modelName,
                contents: contents,
                config: {
                    maxOutputTokens: 65536,
                    temperature: 0.3,
                    topP: 0.9,
                },
            });

            // @ts-ignore
            const stream = streamResult.stream || streamResult;

            let buffer = "";
            let prefixChecked = false;
            // Common prefixes to strip
            const prefixes = [
                "Answer:", "Response:", "Suggestion:", "Here's what you could say:",
                "You could say:", "Try saying:", "Say:", "Inferred question:",
                "Based on the conversation,"
            ];

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

                if (!text) continue;

                if (!prefixChecked) {
                    buffer += text;
                    // Wait for enough characters to check prefix, or just check what we have
                    if (buffer.length > 50) {
                        // Check prefix
                        let content = buffer;
                        for (const prefix of prefixes) {
                            if (content.toLowerCase().startsWith(prefix.toLowerCase())) {
                                content = content.substring(prefix.length).trimStart();
                            }
                        }
                        // Strip markdown check (simplified for streaming - handled by UI mostly)

                        yield content;
                        buffer = "";
                        prefixChecked = true;
                    }
                } else {
                    yield text;
                }
            }

            // Flush remaining buffer if verified
            if (!prefixChecked && buffer.length > 0) {
                let content = buffer;
                for (const prefix of prefixes) {
                    if (content.toLowerCase().startsWith(prefix.toLowerCase())) {
                        content = content.substring(prefix.length).trimStart();
                    }
                }
                yield content;
            }

        } catch (error) {
            console.error("[WhatToAnswerLLM] Streaming generation failed:", error);
            // Fallback for stream error
            yield this.getFallbackAnswer();
        }
    }

    async generate(cleanedTranscript: string): Promise<string> {
        try {
            // Handle empty/thin transcript gracefully
            if (!cleanedTranscript || cleanedTranscript.trim().length < 10) {
                return this.getFallbackAnswer();
            }

            const contents = buildWhatToAnswerContents(cleanedTranscript);

            const response = await this.client.models.generateContent({
                model: this.modelName,
                contents: contents,
                config: {
                    maxOutputTokens: 65536,
                    temperature: 0.3,
                    topP: 0.9,
                },
            });

            // Extract text
            const rawText = response.text
                || response.candidates?.[0]?.content?.parts?.[0]?.text
                || "";

            // Clean but DON'T hard-clamp (let model decide length)
            const cleaned = this.cleanOutput(rawText);

            // Never return empty
            if (!cleaned || cleaned.length < 10) {
                return this.getFallbackAnswer();
            }

            return cleaned;

        } catch (error) {
            console.error("[WhatToAnswerLLM] Generation failed:", error);
            return this.getFallbackAnswer();
        }
    }

    /**
     * Retry logic for 503/Overloaded errors
     */
    private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
        let delay = 500;
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (e: any) {
                // Retry only on 503 or overload
                if (!e.message?.includes("503") && !e.message?.includes("overloaded")) throw e;

                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
            }
        }
        throw new Error("Model busy after retries");
    }

    /**
     * Clean output without hard clamping
     * Removes markdown and unwanted prefixes only
     */
    private cleanOutput(text: string): string {
        const codeBlocks: string[] = [];
        let result = text.trim();

        // Extract code blocks to protect them (WhatToAnswer needs code!)
        result = result.replace(/```[\s\S]*?```/g, (match) => {
            codeBlocks.push(match);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });

        // Strip common prefixes/labels
        const prefixes = [
            "Answer:", "Response:", "Suggestion:", "Here's what you could say:",
            "You could say:", "Try saying:", "Say:", "Inferred question:",
            "Based on the conversation,"
        ];
        for (const prefix of prefixes) {
            if (result.toLowerCase().startsWith(prefix.toLowerCase())) {
                result = result.substring(prefix.length).trim();
            }
        }

        // Collapse excessive newlines but PRESERVE structure (max 2 newlines)
        result = result.replace(/\n{3,}/g, "\n\n");
        // Remove excessive spaces within lines
        // result = result.replace(/[ \t]+/g, " "); // Be careful not to break indentation?
        // Let's stick to just simple trimming of lines if needed, but standard markdown handles spaces well.

        // Restore code blocks
        codeBlocks.forEach((block, index) => {
            result = result.replace(`__CODE_BLOCK_${index}__`, block);
        });

        return result.trim();
    }

    /**
     * Fallback for edge cases - keep it natural
     */
    private getFallbackAnswer(): string {
        const fallbacks = [
            "Could you repeat that? I want to make sure I address your question properly.",
            "That's a great question. Let me think about the best way to explain this.",
            "I'd be happy to elaborate on that. Could you give me a moment?",
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
}
