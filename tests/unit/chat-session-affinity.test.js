// A client session (Pi sends session_id) must stay on the account that last
// served it while that account is available: Claude's prompt cache is per account.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  handleChatCore: vi.fn(async () => ({ success: true, response: new Response("ok") })),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "claude", model: "claude-opus-4-1" })),
  getComboModels: vi.fn(async () => null),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: (k) => k }));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { clearSessionStore } = await import("open-sse/utils/sessionManager.js");

const request = (sessionId) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", session_id: sessionId },
    body: JSON.stringify({ model: "cc/claude-opus-4-1", messages: [{ role: "user", content: "hi" }] }),
  });

// Fill-first over conn-1, conn-2 that honours preferredConnectionId like the real one.
function selectAccounts(available) {
  mocks.getProviderCredentials.mockImplementation(async (_p, exclude, _m, opts) => {
    const pool = available().filter((id) => !exclude.has(id));
    const id = pool.includes(opts.preferredConnectionId) ? opts.preferredConnectionId : pool[0];
    return id ? { connectionId: id, connectionName: id } : null;
  });
}

const preferred = () => mocks.getProviderCredentials.mock.calls.at(-1)[3].preferredConnectionId;
const served = () => mocks.handleChatCore.mock.calls.at(-1)[0].connectionId;

describe("client session → account affinity", () => {
  beforeEach(() => {
    clearSessionStore();
    vi.clearAllMocks();
  });

  it("keeps the session on the account that served it after the first account recovers", async () => {
    let accounts = ["conn-2"]; // conn-1 rate-limited
    selectAccounts(() => accounts);
    await handleChat(request("sess-a"));
    expect(served()).toBe("conn-2");

    accounts = ["conn-1", "conn-2"]; // conn-1 back
    await handleChat(request("sess-a"));
    expect(preferred()).toBe("conn-2");
    expect(served()).toBe("conn-2");

    // A new session still follows fill-first.
    await handleChat(request("sess-b"));
    expect(served()).toBe("conn-1");
  });

  it("falls back when the remembered account is unavailable and remembers the new one", async () => {
    let accounts = ["conn-1", "conn-2"];
    selectAccounts(() => accounts);
    await handleChat(request("sess-a"));
    expect(served()).toBe("conn-1");

    accounts = ["conn-2"];
    await handleChat(request("sess-a"));
    expect(served()).toBe("conn-2");

    accounts = ["conn-1", "conn-2"];
    await handleChat(request("sess-a"));
    expect(served()).toBe("conn-2");
  });

  it("does not record an account that failed", async () => {
    selectAccounts(() => ["conn-1", "conn-2"]);
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "rate_limit_error" })
      .mockResolvedValueOnce({ success: true, response: new Response("ok") });
    await handleChat(request("sess-a"));
    expect(served()).toBe("conn-2");

    await handleChat(request("sess-a"));
    expect(preferred()).toBe("conn-2");
  });
});
