export interface GeneratedNotes {
  cleanedTranscript: string;
  notesText: string;
}

export interface LlmClient {
  generateNotes(rawTranscript: string): Promise<GeneratedNotes>;
}

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
// claude-3.5-haiku -- fast/cheap, good enough for a summarize-and-structure task like this
// (not a reasoning-heavy job), and a real, currently-listed OpenRouter model slug as of writing.
// overridable via AI_NOTES_LLM_MODEL without a code change if a better price/quality tradeoff
// shows up later.
const DEFAULT_MODEL = "anthropic/claude-3.5-haiku";

const SYSTEM_PROMPT = `You clean up raw session transcripts and produce structured notes for Unblur, a peer doubt-resolution platform. Given a raw transcript, respond with a JSON object with exactly two keys:
"cleanedTranscript": the transcript with filler words, false starts, and speaker-label noise cleaned up, but no content removed or invented.
"notesText": structured notes as plain text with these sections: Summary, Key Points, Action Items, Definitions/Formulas (if any topic-specific terms came up). Use short bullet lines under each heading.
Never invent facts not present in the transcript. Respond with only the JSON object, no other text.`;

export class OpenRouterLlmClient implements LlmClient {
  private apiKey: string;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    this.apiKey = apiKey;
    this.model = process.env.AI_NOTES_LLM_MODEL ?? DEFAULT_MODEL;
  }

  async generateNotes(rawTranscript: string): Promise<GeneratedNotes> {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: rawTranscript },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`openrouter chat completion failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error("openrouter response had no message content");
    }

    // the prompt asks for JSON-only, but models sometimes wrap it in a code fence anyway --
    // strip that before parsing rather than failing the whole delivery on a formatting quirk
    const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(jsonText) as { cleanedTranscript: string; notesText: string };
    return { cleanedTranscript: parsed.cleanedTranscript, notesText: parsed.notesText };
  }
}

// test-only -- deterministic output, no network call, no real API key needed
export class FakeLlmClient implements LlmClient {
  calls: string[] = [];

  async generateNotes(rawTranscript: string): Promise<GeneratedNotes> {
    this.calls.push(rawTranscript);
    return {
      cleanedTranscript: rawTranscript.trim(),
      notesText: `Summary:\n- fake summary of the session\n\nKey Points:\n- fake key point\n\nAction Items:\n- fake action item`,
    };
  }
}

// test-only -- simulates the LLM call failing, to prove the worker marks the delivery failed
// rather than crashing
export class ThrowingLlmClient implements LlmClient {
  async generateNotes(): Promise<GeneratedNotes> {
    throw new Error("openrouter unreachable");
  }
}
