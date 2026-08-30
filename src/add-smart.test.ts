import { describe, expect, test } from "bun:test";
import {
  deriveConfigName,
  normalizeUrl,
  parseGitHubUrl,
  shouldIncludePrereleases,
} from "./add-smart.js";

describe("parseGitHubUrl", () => {
  test("accepts repository, releases, and changelog URLs", () => {
    expect(parseGitHubUrl("https://github.com/deepseek-ai/deepseek-harness")).toEqual({
      owner: "deepseek-ai",
      repo: "deepseek-harness",
    });
    expect(parseGitHubUrl("https://github.com/deepseek-ai/deepseek-harness/releases")).toEqual({
      owner: "deepseek-ai",
      repo: "deepseek-harness",
    });
    expect(parseGitHubUrl("https://github.com/deepseek-ai/deepseek-harness.git")).toEqual({
      owner: "deepseek-ai",
      repo: "deepseek-harness",
    });
  });

  test("rejects lookalike hosts and incomplete URLs", () => {
    expect(parseGitHubUrl("https://github.com.evil.example/owner/repo")).toBeNull();
    expect(parseGitHubUrl("https://example.com/github.com/owner/repo")).toBeNull();
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
  });
});

describe("shouldIncludePrereleases", () => {
  test("includes prereleases when they are the only published releases", () => {
    expect(shouldIncludePrereleases([
      { draft: false, prerelease: true },
      { draft: false, prerelease: true },
    ])).toBe(true);
  });

  test("prefers stable releases when at least one exists", () => {
    expect(shouldIncludePrereleases([
      { draft: false, prerelease: true },
      { draft: false, prerelease: false },
    ])).toBe(false);
  });

  test("does not count drafts as published releases", () => {
    expect(shouldIncludePrereleases([{ draft: true, prerelease: true }])).toBe(false);
  });
});

test("normalizes URL variants without query or fragment", () => {
  expect(normalizeUrl("https://example.com/blog/?utm_source=test#latest")).toBe(
    "https://example.com/blog"
  );
});

test("derives a stable hostname-based config name", () => {
  expect(deriveConfigName("https://www.example.com/blog")).toBe("example-com");
});
