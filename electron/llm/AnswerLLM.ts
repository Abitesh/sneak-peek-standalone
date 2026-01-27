// electron/llm/AnswerLLM.ts
// MODE: "What should I say" - Primary auto-answer for interviews
// Generates ready-to-speak first-person responses
// Uses Groq first with Gemini fallback

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { MODE_CONFIGS } from "./types";
import { ANSWER_MODE_PROMPT, GROQ_SYSTEM_PROMPT, buildContents } from "./prompts";

const GEMINI_FLASH_MODEL = "gemini-3-flash-preview";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export class AnswerLLM {
    private client: GoogleGenAI;
    private groqClient: Groq | null = null;
    private modelName: string;
    private config = MODE_CONFIGS.answer;

    constructor(client: GoogleGenAI, modelName: string, groqClient?: Groq | null) {
        this.client = client;
        this.modelName = modelName;
        if (groqClient) {
            this.groqClient = groqClient;
        }
    }

    /**
     * Generate a spoken interview answer
     * @param question - The interviewer's question
     * @param context - Optional conversation context
     * @returns Spoken answer (no post-clamp; prompt enforces brevity)
     */
    async generate(question: string, context?: string): Promise<string> {
        try {
            // Try Groq first if available
            if (this.groqClient) {
                try {
                    console.log(`[AnswerLLM] 🚀 Using Groq (${GROQ_MODEL})...`);
                    const groqMessage = context
                        ? `${GROQ_SYSTEM_PROMPT}\n\nCONTEXT:\n${context}\n\nQUESTION:\n${question}`
                        : `${GROQ_SYSTEM_PROMPT}\n\nQUESTION:\n${question}`;

                    const completion = await this.groqClient.chat.completions.create({
                        model: GROQ_MODEL,
                        messages: [{ role: "user", content: groqMessage }],
                        temperature: 0.3,
                        max_tokens: 2048,
                    });

                    const content = completion.choices[0]?.message?.content;
                    if (content) {
                        console.log(`[AnswerLLM] ✅ Groq generation completed`);
                        return content.trim();
                    }
                } catch (err: any) {
                    console.warn(`[AnswerLLM] ⚠️ Groq failed: ${err.message}, falling back to Gemini`);
                }
            }

            // Fallback to Gemini
            const contents = buildContents(ANSWER_MODE_PROMPT, question, context);
            console.log(`[AnswerLLM] 🔄 Using Gemini fallback (${this.modelName})...`);

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
