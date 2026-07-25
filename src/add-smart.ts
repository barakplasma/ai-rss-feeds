#!/usr/bin/env bun
/**
 * Smart feed adder: detects URL type and uses the right parser mode.
 *
 * Supports:
 *   - GitHub repo URLs → github-releases mode
 *   - GitHub CHANGELOG.md URLs → github-releases mode (uses releases API)
 *   - Blog URLs → LLM-based CSS/JSON mode (delegates to add-feed.ts)
 *
 * Usage:
 *   bun run src/add-smart.ts https://github.com/owner/repo
 *   bun run src/add-smart.ts https://github.com/owner/repo/blob/main/CHANGELOG.md
 *   bun run src/add-smart.ts https://example.com/blog
 */

import RSSParser from "rss-parser";
import * as cheerio from "cheerio";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { fetchGitHubAPI, tolerantFetch, isReachable } from "./fetcher.js";
import { parseArticles } from "./parser.js";
import { validateQuick } from "./validator.js";
import { generateRSS } from "./generator.js";
import { saveSnapshot } from "./snapshot.js";
import type { FeedConfig } from "./types.js";

const CONFIGS_DIR = join(import.meta.dir, "..", "configs");
const FEEDS_DIR = join(import.meta.dir, "..", "feeds");
const REPO = "leontloveless/ai-rss-feeds";
const rssParser = new RSSParser({ timeout: 10000, headers: { "User-Agent": "ai-rss-feeds/1.0" } });

const DISCOVERY_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.8",
};

interface GitHubInfo {
  owner: string;
  repo: string;
}

interface ExistingFeed {
  config: FeedConfig;
  feedUrl: string;
  kind: "native" | "generated";
}

interface DiscoveredFeed {
  url: string;
  title?: string;
  description?: string;
  language?: string;
  author?: string;
}

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href.replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function configFeedUrl(config: FeedConfig): string {
  if (config.parserMode === "external") {
    return config.rssExtraction?.feedUrl || config.url;
  }
  return `https://raw.githubusercontent.com/${REPO}/main/feeds/${config.name}.xml`;
}

function loadConfigs(): FeedConfig[] {
  if (!existsSync(CONFIGS_DIR)) return [];
  return readdirSync(CONFIGS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(CONFIGS_DIR, file), "utf-8")) as FeedConfig);
}

function findExistingFeed(url: string): ExistingFeed | null {
  const requested = normalizeUrl(url);
  for (const config of loadConfigs()) {
    const source = normalizeUrl(config.url);
    const upstream = config.rssExtraction?.feedUrl
      ? normalizeUrl(config.rssExtraction.feedUrl)
      : "";
    if (requested === source || requested === upstream) {
      return {
        config,
        feedUrl: configFeedUrl(config),
        kind: config.parserMode === "external" ? "native" : "generated",
      };
    }
  }
  return null;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    try {
      const normalized = new URL(url).href;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    } catch {
      // ignore invalid candidates
    }
  }
  return result;
}

function addFeedPathCandidates(baseUrl: string, candidates: string[]): void {
  const parsed = new URL(baseUrl);
  const origin = parsed.origin;
  const noSlash = baseUrl.replace(/\/$/, "");
  const pathSegments = parsed.pathname.split("/").filter(Boolean);

  candidates.push(baseUrl);

  if (pathSegments.length > 0) {
    candidates.push(
      `${noSlash}/rss`,
      `${noSlash}/rss/`,
      `${noSlash}/feed`,
      `${noSlash}/feed/`,
      `${noSlash}/feed.xml`,
      `${noSlash}/rss.xml`,
      `${noSlash}/atom.xml`,
      `${noSlash}/index.xml`
    );
  }

  for (const path of [
    "/rss",
    "/rss/",
    "/feed",
    "/feed/",
    "/feed.xml",
    "/rss.xml",
    "/atom.xml",
    "/index.xml",
    "/blog/rss",
    "/blog/rss/",
    "/blog/rss.xml",
    "/blog/feed",
    "/blog/feed/",
    "/blog/feed.xml",
    "/news/rss",
    "/news/rss/",
    "/news/rss.xml",
    "/news/feed",
    "/news/feed/",
    "/news/feed.xml",
  ]) {
    candidates.push(origin + path);
  }
}

function siteDomain(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

async function validateFeedCandidate(feedUrl: string): Promise<DiscoveredFeed | null> {
  try {
    const res = await tolerantFetch(feedUrl, {
      headers: DISCOVERY_HEADERS,
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const text = await res.text();
    const head = text.slice(0, 2000);
    if (!head.includes("<rss") && !head.includes("<feed") && !head.includes("<?xml")) {
      return null;
    }

    const parsed = await rssParser.parseString(text);
    const items = parsed.items ?? [];
    if (items.length === 0) return null;

    const links = items
      .slice(0, 3)
      .map((item) => item.link?.trim())
      .filter((link): link is string => !!link && link.startsWith("http"));
    if (links.length === 0) return null;

    let unreachable = 0;
    for (const link of links) {
      if (!(await isReachable(link))) unreachable++;
    }
    if (unreachable > 1) return null;

    return {
      url: res.url || feedUrl,
      title: parsed.title?.trim(),
      description: parsed.description?.trim(),
      language: parsed.language?.trim(),
      author: (parsed.creator || parsed.author)?.trim(),
    };
  } catch {
    return null;
  }
}

function collectUrlStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectUrlStrings(child, output);
    }
  }
}

function collectHtmlFeedCandidates(pageUrl: string, html: string): string[] {
  const priorityCandidates: string[] = [];
  const fallbackCandidates: string[] = [];
  const $ = cheerio.load(html);
  const parsedPage = new URL(pageUrl);
  const pageDomain = siteDomain(parsedPage.hostname);
  const preferredSlugs = new Set(
    parsedPage.pathname
      .split("/")
      .filter((segment) => segment && !["blog", "news", "tag", "category"].includes(segment))
  );

  $("link[rel~='alternate']").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    const href = $(el).attr("href");
    if (!href || (!type.includes("rss") && !type.includes("atom") && !type.includes("xml"))) {
      return;
    }
    priorityCandidates.push(new URL(href, pageUrl).href);
  });

  const discoveredUrls = new Set<string>();
  let hasPreferredTagFeed = false;
  $("script[type='application/json'], script#__NEXT_DATA__").each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;
    try {
      collectUrlStrings(JSON.parse(raw), discoveredUrls);
    } catch {
      // ignore non-JSON script tags
    }
  });

  for (const url of discoveredUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (siteDomain(parsed.hostname) !== pageDomain) continue;

    const tagMatch = parsed.pathname.match(/\/tag\/([^/]+)\/?$/);
    if (tagMatch) {
      const tagFeed = `${url.replace(/\/$/, "")}/rss/`;
      if (preferredSlugs.has(tagMatch[1])) {
        hasPreferredTagFeed = true;
        priorityCandidates.push(tagFeed);
      } else {
        fallbackCandidates.push(tagFeed);
      }
    }

    if (!/\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(parsed.pathname)) {
      for (const slug of preferredSlugs) {
        priorityCandidates.push(`${parsed.origin}/tag/${slug}/rss/`);
      }
      addFeedPathCandidates(parsed.origin, fallbackCandidates);
    }
  }

  return uniqueUrls(hasPreferredTagFeed ? priorityCandidates : [...priorityCandidates, ...fallbackCandidates]);
}

/**
 * Try to extract GitHub owner/repo from a URL.
 */
function parseGitHubUrl(url: string): GitHubInfo | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+?)(?:\/|\.git|$)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Check if a GitHub repo has releases.
 */
async function hasGitHubReleases(owner: string, repo: string): Promise<boolean> {
  try {
    const json = await fetchGitHubAPI(owner, repo, 1);
    const releases = JSON.parse(json);
    return Array.isArray(releases) && releases.length > 0;
  } catch {
    return false;
  }
}

async function addGitHubReleasesFeed(info: GitHubInfo): Promise<void> {
  const { owner, repo } = info;
  const name = `${repo}-releases`;

  console.log(`\n🔍 Detected GitHub repo: ${owner}/${repo}`);
  console.log("📦 Checking for releases...");

  const hasReleases = await hasGitHubReleases(owner, repo);
  if (!hasReleases) {
    console.error(`❌ No releases found for ${owner}/${repo}`);
    process.exit(1);
  }

  console.log("✅ Releases found, creating github-releases feed...\n");

  // Fetch releases
  const json = await fetchGitHubAPI(owner, repo, 50);
  console.log(`✅ Fetched releases from API`);

  // Build config
  const config: FeedConfig = {
    name,
    url: `https://github.com/${owner}/${repo}/releases`,
    feed: {
      title: `${repo} Releases`,
      description: `GitHub releases for ${owner}/${repo}`,
      language: "en",
      author: owner,
    },
    selectors: { articleList: "", title: "", link: { source: "" } },
    parserMode: "github-releases",
    githubReleasesExtraction: {
      owner,
      repo,
      includePrerelease: false,
      limit: 50,
    },
    createdAt: new Date().toISOString(),
  };

  // Parse and validate
  const articles = await parseArticles(json, config);
  console.log(`📝 Parsed ${articles.length} releases`);

  if (articles.length === 0) {
    console.error("❌ No releases parsed");
    process.exit(1);
  }

  const validation = validateQuick(articles);
  if (!validation.valid) {
    console.error("❌ Validation failed:", validation.errors);
    process.exit(1);
  }
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      console.warn(`⚠️  ${w}`);
    }
  }

  // Generate RSS
  const xml = generateRSS(articles, config);

  // Save
  mkdirSync(CONFIGS_DIR, { recursive: true });
  mkdirSync(FEEDS_DIR, { recursive: true });

  writeFileSync(join(CONFIGS_DIR, `${name}.json`), JSON.stringify(config, null, 2));
  writeFileSync(join(FEEDS_DIR, `${name}.xml`), xml);
  saveSnapshot(name, articles);

  console.log(`\n✅ Feed added successfully!`);
  console.log(`   Config: configs/${name}.json`);
  console.log(`   Feed:   feeds/${name}.xml`);
  console.log(`   Items:  ${articles.length}`);
  console.log(
    `\n📖 Subscribe: https://raw.githubusercontent.com/leontloveless/ai-rss-feeds/main/feeds/${name}.xml`
  );
}

/**
 * Try to discover an existing RSS/Atom feed for a URL.
 * Checks common feed paths and HTML <link> tags.
 */
async function discoverExistingRSS(url: string): Promise<DiscoveredFeed | null> {
  const candidates: string[] = [];
  addFeedPathCandidates(url, candidates);

  try {
    const res = await tolerantFetch(url, {
      headers: DISCOVERY_HEADERS,
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (res.ok) {
      const html = await res.text();
      candidates.push(...collectHtmlFeedCandidates(res.url || url, html));
    }
  } catch {
    // Discovery should not block the LLM fallback.
  }

  for (const candidate of uniqueUrls(candidates)) {
    const valid = await validateFeedCandidate(candidate);
    if (valid) return valid;
  }

  return null;
}

async function main() {
  const url = process.argv[2];
  if (!url || !url.startsWith("http")) {
    console.error("Usage: bun run src/add-smart.ts <url>");
    console.error("  Supports: GitHub repos, CHANGELOG.md URLs, blog URLs");
    process.exit(1);
  }

  // Check if this request is already covered before doing any work.
  const existing = findExistingFeed(url);
  if (existing) {
    console.log(`\n✅ Existing feed already configured: ${existing.config.name}`);
    console.log(`📖 Subscribe: ${existing.feedUrl}`);
    process.stdout.write(`existing_feed_url=${existing.feedUrl}\n`);
    process.stdout.write(`existing_config_name=${existing.config.name}\n`);
    process.stdout.write(`existing_feed_kind=${existing.kind}\n`);
    process.exit(0);
  }

  // Check if it's a GitHub URL
  const ghInfo = parseGitHubUrl(url);
  if (ghInfo) {
    await addGitHubReleasesFeed(ghInfo);
    return;
  }

  // Check if the site already has a native RSS feed
  console.log("🔍 Checking for existing RSS feed...");
  const existingFeed = await discoverExistingRSS(url);
  if (existingFeed) {
    console.log(`\n✅ Native RSS feed found: ${existingFeed.url}`);
    // Create minimal config for README tracking (parserMode=external, no generated feed file)
    const name = deriveConfigName(url);
    const hostname = new URL(url).hostname;
    const config: FeedConfig = {
      name,
      url,
      feed: {
        title: existingFeed.title || hostname,
        description: existingFeed.description || `External RSS: ${existingFeed.url}`,
        language: existingFeed.language || "en",
        author: existingFeed.author || hostname,
      },
      selectors: { articleList: "", title: "", link: { source: "" } },
      parserMode: "external",
      rssExtraction: { feedUrl: existingFeed.url },
      createdAt: new Date().toISOString(),
    };
    mkdirSync(CONFIGS_DIR, { recursive: true });
    writeFileSync(join(CONFIGS_DIR, `${name}.json`), JSON.stringify(config, null, 2));
    console.log(`   Config: configs/${name}.json (external)`);
    console.log(`📖 Subscribe: ${existingFeed.url}`);
    process.stdout.write(`native_feed_url=${existingFeed.url}\n`);
    process.exit(0);
  }

  // Fall back to LLM-based add-feed
  console.log("🌐 No existing RSS found, using LLM-based parser...\n");

  // Dynamic import to avoid loading LLM deps when not needed
  const { execSync } = await import("child_process");
  execSync(`bun run src/add-feed.ts "${url}"`, { stdio: "inherit" });
}

async function addRssMirrorFeed(originalUrl: string, feedUrl: string): Promise<void> {
  console.log(`\n🔍 Found native RSS feed: ${feedUrl}`);
  console.log("📦 Fetching upstream feed...");

  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "ai-rss-feeds/1.0" },
  });
  if (!response.ok) {
    console.error(`❌ Failed to fetch feed: ${response.status}`);
    process.exit(1);
  }
  const xml = await response.text();

  const parsed = await rssParser.parseString(xml);
  const feedTitle = (parsed.title || new URL(originalUrl).hostname)?.trim();
  const feedDescription = (parsed.description || `RSS mirror of ${originalUrl}`)?.trim();

  const name = deriveConfigName(originalUrl);

  const config: FeedConfig = {
    name,
    url: originalUrl,
    feed: {
      title: feedTitle,
      description: feedDescription,
      language: parsed.language || "en",
      author: parsed.creator || parsed.author || new URL(originalUrl).hostname,
    },
    selectors: { articleList: "", title: "", link: { source: "" } },
    parserMode: "rss",
    rssExtraction: { feedUrl },
    createdAt: new Date().toISOString(),
  };

  const articles = await parseArticles(xml, config);
  console.log(`📝 Parsed ${articles.length} articles`);

  if (articles.length === 0) {
    console.error("❌ No articles parsed from RSS");
    process.exit(1);
  }

  const validation = validateQuick(articles);
  if (!validation.valid) {
    console.error("❌ Validation failed:", validation.errors);
    process.exit(1);
  }

  const rssXml = generateRSS(articles, config);

  mkdirSync(CONFIGS_DIR, { recursive: true });
  mkdirSync(FEEDS_DIR, { recursive: true });

  writeFileSync(join(CONFIGS_DIR, `${name}.json`), JSON.stringify(config, null, 2));
  writeFileSync(join(FEEDS_DIR, `${name}.xml`), rssXml);
  saveSnapshot(name, articles);

  console.log(`\n✅ Feed added successfully!`);
  console.log(`   Config: configs/${name}.json`);
  console.log(`   Feed:   feeds/${name}.xml`);
  console.log(`   Items:  ${articles.length}`);
  console.log(
    `\n📖 Subscribe: https://raw.githubusercontent.com/leontloveless/ai-rss-feeds/main/feeds/${name}.xml`
  );
}

function deriveConfigName(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.hostname.split(".");
  const slug = parts.length > 2
    ? parts.slice(-2).join("-")
    : parts.join("-");
  return slug.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
