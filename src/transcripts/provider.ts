export interface TranscriptSummary {
  transcriptId: string;
  status: string;
}

// Strategy pattern -- same shape as meeting-service's VideoRoomProvider, so Daily can be
// swapped for another transcription provider without touching the worker
export interface TranscriptProvider {
  listTranscripts(roomName: string): Promise<TranscriptSummary[]>;
  getTranscriptText(transcriptId: string): Promise<string>;
}

const DAILY_API_BASE = "https://api.daily.co/v1";

export class DailyTranscriptProvider implements TranscriptProvider {
  async listTranscripts(roomName: string): Promise<TranscriptSummary[]> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/transcript?roomName=${encodeURIComponent(roomName)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`daily list transcripts failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { data: { transcriptId: string; status: string }[] };
    return json.data.map((t) => ({ transcriptId: t.transcriptId, status: t.status }));
  }

  async getTranscriptText(transcriptId: string): Promise<string> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    // Daily's access-link endpoint returns a short-lived signed URL to the transcript file
    // (webvtt/txt), not the text itself -- fetch it, then fetch the text from that link
    const linkRes = await fetch(`${DAILY_API_BASE}/transcript/${encodeURIComponent(transcriptId)}/access-link`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!linkRes.ok) {
      const body = await linkRes.text().catch(() => "");
      throw new Error(`daily get transcript access link failed: ${linkRes.status} ${body}`);
    }
    const { link } = (await linkRes.json()) as { link: string };

    const textRes = await fetch(link);
    if (!textRes.ok) {
      throw new Error(`fetching transcript file from daily's signed link failed: ${textRes.status}`);
    }
    return await textRes.text();
  }
}

// test-only -- deterministic transcripts, no network call, no real credential needed
export class FakeTranscriptProvider implements TranscriptProvider {
  // test seam: seed which transcripts a given room has, and what text a given transcript id holds
  transcriptsByRoom = new Map<string, TranscriptSummary[]>();
  textByTranscriptId = new Map<string, string>();

  async listTranscripts(roomName: string): Promise<TranscriptSummary[]> {
    return this.transcriptsByRoom.get(roomName) ?? [];
  }

  async getTranscriptText(transcriptId: string): Promise<string> {
    const text = this.textByTranscriptId.get(transcriptId);
    if (text === undefined) {
      throw new Error(`no fake transcript text seeded for ${transcriptId}`);
    }
    return text;
  }
}
