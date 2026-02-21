/** Tests for the HTTP API client. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as api from "./api";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("api request wrapper", () => {
  it("throws an error for non-ok responses", async () => {
    mockFetch.mockResolvedValue(mockResponse("Not found", false, 404));

    await expect(api.getMe()).rejects.toThrow("API 404");
  });

  it("sends Content-Type: application/json header", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "1", name: "test" }));

    await api.getMe();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });
});

describe("user endpoints", () => {
  it("onboardUser sends POST with payload", async () => {
    const user = { id: "1", name: "test" };
    mockFetch.mockResolvedValue(mockResponse(user));

    await api.onboardUser({ name: "test" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/users/onboard",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "test" }),
      }),
    );
  });

  it("getMe sends GET to /users/me", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "1" }));

    await api.getMe();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("updateProfile sends PATCH", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "1" }));

    await api.updateProfile({ name: "new-name", display_name: "New" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/users/me",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "new-name", display_name: "New" }),
      }),
    );
  });

  it("deleteProfile sends DELETE and returns undefined for 204", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });

    const result = await api.deleteProfile();

    expect(mockFetch).toHaveBeenCalledWith("/api/users/me", {
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
    expect(result).toBeUndefined();
  });
});

describe("channel endpoints", () => {
  it("listChannels sends GET to /channels", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await api.listChannels();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/channels",
      expect.anything(),
    );
  });

  it("createChannel sends POST with name", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "1" }));

    await api.createChannel("test-channel");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/channels",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "test-channel" }),
      }),
    );
  });
});

describe("message endpoints", () => {
  it("getMessages constructs URL with query params", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await api.getMessages("ch1", { limit: 25, before: "2026-01-01" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/channels/ch1/messages?limit=25&before=2026-01-01",
      expect.anything(),
    );
  });

  it("getMessages omits query string when no params", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await api.getMessages("ch1");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/channels/ch1/messages",
      expect.anything(),
    );
  });

  it("sendMessage sends POST with content and mentions", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "m1" }));

    await api.sendMessage("ch1", "Hello @agent-a", ["agent-a"]);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/channels/ch1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "Hello @agent-a", mentions: ["agent-a"] }),
      }),
    );
  });
});

describe("agent endpoints", () => {
  it("listAgents sends GET to /agents", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await api.listAgents();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/agents",
      expect.anything(),
    );
  });

  it("getOrCreateDM sends POST to /agents/{name}/dm", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "1" }));

    await api.getOrCreateDM("cosmic-penguin");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/agents/cosmic-penguin/dm",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("feature endpoints", () => {
  it("listFeatures sends GET without status filter", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await api.listFeatures();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features",
      expect.anything(),
    );
  });

  it("listFeatures includes status filter when provided", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));

    await api.listFeatures("open");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features?status=open",
      expect.anything(),
    );
  });

  it("createFeature sends POST with title and description", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "f1" }));

    await api.createFeature("New Feature", "A cool feature");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "New Feature", description: "A cool feature" }),
      }),
    );
  });

  it("voteFeature sends POST with vote value", async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: "ok", vote: 1 }));

    await api.voteFeature("f1", 1);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features/f1/vote",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ vote: 1 }),
      }),
    );
  });

  it("updateFeature sends PATCH with status and reason", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "f1", status: "done" }));

    await api.updateFeature("f1", "done", "Shipped in v0.2");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features/f1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "done", reason: "Shipped in v0.2" }),
      }),
    );
  });

  it("updateFeature sends PATCH without reason", async () => {
    mockFetch.mockResolvedValue(mockResponse({ id: "f1", status: "planned" }));

    await api.updateFeature("f1", "planned");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features/f1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "planned" }),
      }),
    );
  });

  it("deleteFeature sends DELETE", async () => {
    mockFetch.mockResolvedValue(mockResponse({ deleted: true, id: "f1" }));

    await api.deleteFeature("f1");

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/features/f1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
