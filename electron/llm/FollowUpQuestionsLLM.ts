// electron/llm/FollowUpQuestionsLLM.ts
// MODE: Follow-Up Questions - Suggests strategic questions for the user
// Active, triggered by user request
// Uses Groq first with Gemini fallback

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MODE_CONFIGS } from "./types";
import { FOLLOW_UP_QUESTIONS_MODE_PROMPT, GROQ_FOLLOW_UP_QUESTIONS_PROMPT, buildContents } from "./prompts";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export class FollowUpQuestionsLLM {
    private client: GoogleGenAI;
    private groqClient: Groq | null = null;
    private modelName: string;
    private config = MODE_CONFIGS.followUpQuestions;

    constructor(client: GoogleGenAI, modelName: string, groqClient?: Groq | null) {
        this.client = client;
        this.modelName = modelName;
        if (groqClient) {
            this.groqClient = groqClient;
        }
    }

    /**
     * Generate strategic follow-up questions for the user
     * @param context - Current conversation context
     * @returns List of 3 questions
     */
    async generate(context: string): Promise<string> {
        try {
            if (!context.trim()) {
                return "";
            }

            // Try Groq first if available
            if (this.groqClient) {
                try {
                    console.log(`[FollowUpQuestionsLLM] 🚀 Using Groq (${GROQ_MODEL})...`);
                    const groqMessage = `${GROQ_FOLLOW_UP_QUESTIONS_PROMPT}\n\nCONVERSATION:\n${context}`;

                    const completion = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        temperature: 0.4,
                        max_tokens: 512,
                    });

                    const content = completion.choices[0]?.message?.content;
                    if (content) {
                        console.log(`[FollowUpQuestionsLLM] ✅ Groq generation completed`);
                        return content.trim();
                    }
                } catch (err: any) {
                    console.warn(`[FollowUpQuestionsLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini
            const contents = buildContents(
                FOLLOW_UP_QUESTIONS_MODE_PROMPT,
                "Suggest MAX 4 brief follow-up questions based on this context.",
                context
            );

            console.log(`[FollowUpQuestionsLLM] 🔄 Using Gemini fallback (${this.modelName})...`);

            const response = await this.client.models.generateContent({
                model: this.modelName,
                contents: contents,
                config: {
                    maxOutputTokens: this.config.maxOutputTokens,
                    temperature: this.config.temperature,
                    topP: this.config.topP,
                },
            });

            // Try multiple ways to extract text - handle different response structures
            let rawText = "";

            // Method 1: Direct response.text
            if (response.text) {
                rawText = response.text;
            }
            // Method 2: candidate.content.parts array (check all parts)
            else if (response.candidates?.[0]?.content?.parts) {
                const candidate = response.candidates[0];
                const parts = Array.isArray(candidate.content.parts) ? candidate.content.parts : [candidate.content.parts];
                for (const part of parts) {
                    if (part?.text) {
                        rawText += part.text;
                    }
                }
            }
            // Method 3: candidate.content directly (if it's a string)
            else if (response.candidates?.[0]?.content) {
                const content = response.candidates[0].content;
                if (typeof content === 'string') {
                    rawText = content;
                }
            }

            if (!rawText || rawText.trim().length === 0) {
                console.error("[FollowUpQuestionsLLM] Empty response. Response structure:", JSON.stringify({
                    hasResponseText: !!response.text,
                    candidateContent: response.candidates?.[0]?.content,
                    candidateParts: response.candidates?.[0]?.content?.parts,
                }, null, 2));
            }

            return rawText.trim();

        } catch (error) {
            console.error("[FollowUpQuestionsLLM] Generation failed:", error);
            return "";
        }
    }

    /**
     * Generate strategic follow-up questions (Streamed)
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
                    console.log(`[FollowUpQuestionsLLM] 🚀 Using Groq (${GROQ_MODEL})...`);
                    const groqMessage = `${GROQ_FOLLOW_UP_QUESTIONS_PROMPT}\n\nCONVERSATION:\n${context}`;

                    const stream = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        stream: true,
                        temperature: 0.4,
                        max_tokens: 512,
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
                        console.log(`[FollowUpQuestionsLLM] ✅ Groq stream completed`);
                        return; // Success - done
                    }
                } catch (err: any) {
                    console.warn(`[FollowUpQuestionsLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini
            const contents = buildContents(
                FOLLOW_UP_QUESTIONS_MODE_PROMPT,
                "Suggest MAX 4 brief follow-up questions based on this context.",
                context
            );

            console.log(`[FollowUpQuestionsLLM] 🔄 Using Gemini fallback (${this.modelName})...`);

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
            console.error("[FollowUpQuestionsLLM] Streaming generation failed:", error);
            yield "";
        }
    }
}
