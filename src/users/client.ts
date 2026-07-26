export interface EnabledUser {
  id: string;
  email: string;
  name: string;
}

// backed by user-service's POST /internal/users/bulk (added alongside this service) -- one round
// trip for a session's whole participant list instead of N sequential per-user calls
export interface UserClient {
  getEnabledUsers(userIds: string[]): Promise<EnabledUser[]>;
}

const REQUEST_TIMEOUT_MS = 2000;

interface BulkUserResponse {
  id: string;
  email: string;
  name: string;
  aiNotesAndTranscriptsEnabled: boolean;
}

export class HttpUserClient implements UserClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(baseUrl = process.env.USER_SERVICE_URL ?? "", internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "") {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async getEnabledUsers(userIds: string[]): Promise<EnabledUser[]> {
    if (userIds.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/users/bulk", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({ userIds }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`user service returned ${res.status} fetching bulk profiles`);
      }
      const body = (await res.json()) as { users: BulkUserResponse[] };
      return body.users
        .filter((u) => u.aiNotesAndTranscriptsEnabled)
        .map((u) => ({ id: u.id, email: u.email, name: u.name }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeUserClient implements UserClient {
  private users = new Map<string, BulkUserResponse>();

  seed(user: BulkUserResponse): void {
    this.users.set(user.id, user);
  }

  async getEnabledUsers(userIds: string[]): Promise<EnabledUser[]> {
    return userIds
      .map((id) => this.users.get(id))
      .filter((u): u is BulkUserResponse => !!u && u.aiNotesAndTranscriptsEnabled)
      .map((u) => ({ id: u.id, email: u.email, name: u.name }));
  }
}
