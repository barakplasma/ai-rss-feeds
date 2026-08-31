import { afterEach, describe, expect, test } from "bun:test";
import { fetchHTML } from "./fetcher.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchHTML access blocks", () => {
  test("classifies DataDome 403 responses as unhealable static-fetch blocks", async () => {
    globalThis.fetch = (async () =>
      new Response("blocked", {
        status: 403,
        headers: { "x-datadome": "protected" },
      })) as unknown as typeof fetch;

    await expect(fetchHTML("https://example.com", 100, 0)).rejects.toThrow(
      "DataDome bot detection. This site cannot be scraped with static HTTP requests."
    );
  });

  test("classifies generic 403 responses as unhealable static-fetch blocks", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(fetchHTML("https://example.com", 100, 0)).rejects.toThrow(
      "HTTP 403 Forbidden — access is blocked. This site cannot be scraped with static HTTP requests."
    );
  });
});
