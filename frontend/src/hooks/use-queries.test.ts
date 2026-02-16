/** Tests for TanStack Query key factories. */
import { describe, it, expect } from "vitest";
import { queryKeys } from "./use-queries";

describe("queryKeys", () => {
  it("me returns a stable key", () => {
    expect(queryKeys.me).toEqual(["me"]);
  });

  it("channels returns a stable key", () => {
    expect(queryKeys.channels).toEqual(["channels"]);
  });

  it("agents returns a stable key", () => {
    expect(queryKeys.agents).toEqual(["agents"]);
  });

  it("features returns key with status param", () => {
    expect(queryKeys.features("open")).toEqual(["features", "open"]);
  });

  it("features returns key with undefined status", () => {
    expect(queryKeys.features()).toEqual(["features", undefined]);
  });

  it("messages returns key with channel ID", () => {
    expect(queryKeys.messages("ch-123")).toEqual(["messages", "ch-123"]);
  });
});
