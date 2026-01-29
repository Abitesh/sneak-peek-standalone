# Natively

**Natively** is an intelligent, privacy-first desktop assistant designed to provide real-time insights and support during your professional interactions. Whether you're in a high-stakes interview, a client presentation, or deep in a technical discussion, Natively works invisibly in the background to empower you.

Built with performance and privacy in mind, it combines the power of local AI (Ollama) with cloud capabilities (Gemini, Groq) to deliver instant answers, meeting context, and automated follow-ups.

## ✨ Key Features

*   **🎙️ Smart Audio Intelligence**
    *   **Native Audio Capture**: Powered by a custom **Rust-based native module** for high-performance, low-latency audio capture from both system output and microphones.
    *   **Real-time Transcription**: Accurate, live transcription of meetings and calls.
    *   **Audio Restoration**: Automatically restores your original audio device settings after capture sessions, ensuring a seamless experience.

*   **🧠 Conversation Intelligence**
    *   **"What Should I Say?"**: Advanced intent classification tailored to the unique flow of your conversation.
    *   **Contextual Chat**: Ask questions about the current meeting context using the dedicated, non-intrusive chat overlay.
    *   **Live Guidance**: Receive suggestions, fact-checks, and technical answers in real-time as the conversation happens.

*   **✉️ Meeting Automation**
    *   **Smart Follow-ups**: Auto-generate professional follow-up emails based on meeting context, decisions, and action items.
    *   **Recipient Discovery**: Intelligently identifies email recipients from calendar invites and transcripts.

*   **📸 Visual Intelligence**
    *   **Smart Screenshots**: Analyze screen content instantly with `Cmd+H` for explanations or problem-solving.
    *   **Invisible Overlay**: A click-through, always-on-top UI that keeps you informed without blocking your workflow.

*   **🔒 Privacy First**
    *   **Local Processing**: Full support for Ollama models (Llama 3, Mistral) for 100% private data handling.
    *   **Data Control**: ALL data is stored locally in SQLite. You own your transcripts and history.

## 🏗️ Architecture

Natively is built on a modern, robust stack designed for performance, stability, and cross-platform compatibility:

*   **Core**: [Electron](https://www.electronjs.org/) (v33) provides the secure, rich desktop environment.
*   **High-Performance Audio**: The critical audio capture pipeline is built in **Rust** 🦀 and exposed as a Node.js native addon (N-API). This ensures glitch-free, synchronized audio capture from multiple sources.
*   **Frontend**: Built with **React** and **TypeScript**, powered by **Vite** for a fast, reactive user interface.
    *   *Styling*: **TailwindCSS** for a premium, sleek aesthetic.
    *   *State*: **React Query** for efficient data synchronization.
*   **Data Layer**: **Better-SQLite3** for reliable, local-first data persistence.
*   **AI Orchestration**: Hybrid engine supporting multiple providers:
    *   **Google Gemini 2.0 Flash**: For powerful multimodal (text + vision) cloud processing.
    *   **Groq**: For ultra-fast, low-latency inference.
    *   **Ollama**: For completely offline, private inference.

## 🚀 Quick Start

### Prerequisites
*   **Node.js** (v20+ recommended)
*   **Rust** (Required for building the native audio module)
*   **Ollama** (Recommended for local AI support)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/evinjohnn/Natively.git
    cd Natively
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```
    *Note: This command will automatically build the Rust native module.*

3.  **Setup Environment**
    Create a `.env` file in the root directory:
    ```env
    # For Cloud AI (Optional but recommended for Vision)
    GEMINI_API_KEY=your_key_here
    
    # For Local AI (Default)
    USE_OLLAMA=true
    OLLAMA_MODEL=llama3.2
    ```

4.  **Run Development Mode**
    ```bash
    npm start
    ```

## ⚠️ Troubleshooting

**Build Errors (Sharp/Native Modules)**
If you encounter errors related to `sharp` or the native module build:
```bash
# Clean and reinstall
rm -rf node_modules package-lock.json
npm install
```
Ensure you have Rust installed (`cargo --version`) as it is required for the audio module.

## 👨‍💻 Contributor

**Evin** (@evinjohnn)  
*Creator & Lead Developer*

---

**License**: ISC
