// electron/llm/WhatToAnswerLLM.ts
// MODE: "What to Answer" - Manual trigger for interview copilot
// Single-pass question inference + answer generation
// NEVER returns empty - always provides a usable response
// Uses Groq first with Gemini fallback

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import * as fs from "fs";
import { WHAT_TO_ANSWER_PROMPT, GROQ_WHAT_TO_ANSWER_PROMPT, TEMPORAL_CONTEXT_TEMPLATE, buildWhatToAnswerContents } from "./prompts";
import { TemporalContext, formatTemporalContextForPrompt } from "./TemporalContextBuilder";
import { IntentResult, ConversationIntent } from "./IntentClassifier";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export class WhatToAnswerLLM {
    private client: GoogleGenAI;
    private groqClient: Groq | null = null;
    private modelName: string;

    constructor(client: GoogleGenAI, modelName: string = GEMINI_FLASH_MODEL, groqClient?: Groq | null) {
        this.client = client;
        this.modelName = modelName;
        if (groqClient) {
            this.groqClient = groqClient;
        }
    }

    /**
     * Build the prompt with temporal context and intent guidance injected
     */
    private buildEnrichedPrompt(temporalContext?: TemporalContext, intentResult?: IntentResult): string {
        let basePrompt = GROQ_WHAT_TO_ANSWER_PROMPT;

        // Build sections to inject
        const sections: string[] = [];

        // 1. Intent + Answer Shape guidance (CRITICAL for quality)
        if (intentResult) {
            sections.push(`<intent_and_shape>
DETECTED INTENT: ${intentResult.intent}
ANSWER SHAPE: ${intentResult.answerShape}
</intent_and_shape>`);
        }

        // 2. Temporal context (anti-repetition)
        if (temporalContext && temporalContext.hasRecentResponses) {
            let temporalSection = TEMPORAL_CONTEXT_TEMPLATE;

            // Inject previous responses
            if (temporalContext.previousResponses.length > 0) {
                const responsesText = temporalContext.previousResponses
                    .map((r, i) => `${i + 1}. "${r}"`)
                    .join('\n');
                temporalSection = temporalSection.replace('{PREVIOUS_RESPONSES}', responsesText);
            } else {
                temporalSection = temporalSection.replace('{PREVIOUS_RESPONSES}', '(none yet)');
            }

            // Inject tone guidance
            if (temporalContext.toneSignals.length > 0) {
                const primary = temporalContext.toneSignals.sort((a, b) => b.confidence - a.confidence)[0];
                temporalSection = temporalSection.replace(
                    '{TONE_GUIDANCE}',
                    `Maintain ${primary.type} tone to stay consistent with your previous responses.`
                );
            } else {
                temporalSection = temporalSection.replace(
                    '{TONE_GUIDANCE}',
                    'Match the natural tone of the conversation.'
                );
            }

            sections.push(temporalSection);
        }

        // Inject all sections into the TEMPORAL_CONTEXT placeholder
        const contextInjection = sections.length > 0 ? sections.join('\n\n') : '';
        return basePrompt.replace('{TEMPORAL_CONTEXT}', contextInjection);
    }

    /**
     * Generate a spoken interview answer from transcript context (Streamed)
     * Uses Groq first if available (text-only), falls back to Gemini
     * Supports multimodal: when imagePath is provided, uses Gemini directly
     * @param cleanedTranscript - The cleaned and formatted transcript
     * @param temporalContext - Optional temporal context for anti-repetition
     * @param intentResult - Optional intent classification for answer shaping
     * @param imagePath - Optional path to screenshot for visual context
     */
    async *generateStream(
        cleanedTranscript: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePath?: string
    ): AsyncGenerator<string> {
        try {
            // Handle empty/thin transcript gracefully (but allow if image is present)
            if ((!cleanedTranscript || cleanedTranscript.trim().length < 10) && !imagePath) {
                const fallback = this.getFallbackAnswer();
                yield fallback;
                return;
            }

            // Try Groq first if available (text-only, skip if image is present)
            if (this.groqClient && !imagePath) {
                try {
                    console.log(`[WhatToAnswerLLM] 🚀 Using Groq (${GROQ_MODEL}), intent: ${intentResult?.intent || 'general'}...`);
                    const enrichedPrompt = this.buildEnrichedPrompt(temporalContext, intentResult);
                    const groqMessage = `${enrichedPrompt}\n\nCONVERSATION:\n${cleanedTranscript}`;

                    const stream = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        stream: true,
                        temperature: 0.3,
                        max_tokens: 4096,
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
                        console.log(`[WhatToAnswerLLM] ✅ Groq stream completed`);
                        return; // Success - done
                    }
                } catch (err: any) {
                    console.warn(`[WhatToAnswerLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini (or primary when image is present)
            console.log(`[WhatToAnswerLLM] 🔄 Using Gemini${imagePath ? ' with image' : ''}...`);

            // Build contents - include image if present
            let contents: any[] = buildWhatToAnswerContents(cleanedTranscript || 'Analyze the attached image and suggest what to say.');

            // Add image to the request if present
            if (imagePath) {
                try {
                    const imageData = fs.readFileSync(imagePath);
                    const base64Image = imageData.toString('base64');
                    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

                    // Prepend image context instruction
                    contents = [
                        {
                            role: "user",
                            parts: [
                                { text: WHAT_TO_ANSWER_PROMPT },
                                {
                                    inlineData: {
                                        data: base64Image,
                                        mimeType: mimeType
                                    }
                                },
                                { text: `\n\nAn image is attached showing visual context (code, question, or problem). Analyze it together with the conversation below and suggest what the user should say.\n\nCONVERSATION:\n${cleanedTranscript || '(No recent transcript - focus on the image)'}` }
                            ]
                        }
                    ];
                    console.log(`[WhatToAnswerLLM] 📸 Image attached: ${imagePath}`);
                } catch (imgErr: any) {
                    console.warn(`[WhatToAnswerLLM] ⚠️ Failed to read image: ${imgErr.message}`);
                }
            }

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
