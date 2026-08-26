/**
 * LLM integration: HTML → FeedConfig via OpenRouter.
 */

import type { FeedConfig } from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";
const MAX_RETRIES = 3;
const MAX_HTML_CHARS = 12_000;

const SYSTEM_PROMPT = `You are an expert at analyzing HTML structure to extract blog article listings.

Given an HTML page of a blog index, output a JSON object matching this exact TypeScript interface:

\`\`\`typescript
interface FeedConfig {
  name: string;
  url: string;
  feed: {
    title: string;
    description: string;
    language: string;
    author?: string;
  };
  selectors: {
    articleList: string;
    title: string;
    date?: string;
    description?: string;
    link: {
      selector?: string;
      source: string;
      prefix?: string;
    };
  };
  parserMode?: "css" | "json" | "changelog";
  changelogExtraction?: {
    linkTemplate?: string;
    sections?: string[];
  };
  dateFormat?: string;
  createdAt: string;
}
\`\`\`

Rules:
1. The \`articleList\` selector should match EACH individual article/post entry.
2. \`title\` selector is RELATIVE to the articleList element.
3. For \`link.source\`, use "attr:href". If the link is not inside the title selector, set \`link.selector\` to the <a> tag selector relative to articleList.
4. If URLs are relative (e.g. "/blog/post-1"), set \`link.prefix\` to the site origin.
5. Only output valid JSON. No markdown, no explanation, no code fences.
6. Set \`createdAt\` to today's date in ISO format.
7. If the page is a CHANGELOG or release notes in "Keep a Changelog" format (## headings for versions, ### for categories), set \`parserMode\` to "changelog" and provide \`changelogExtraction\` with \`linkTemplate\` if the source is a GitHub repo.
8. Selectors must be valid Cheerio/css-select syntax. If a class name contains ":" (for example Tailwind "hover:underline"), escape the colon as "\\\\:" in JSON, or prefer a stable structural selector such as article, a[href], h1-h3, time, or data-* attributes.
9. Avoid Tailwind utility classes and generated/hash-like classes when stable tags or attributes are available.`;

export async function generateConfig(
  url: string,
  html: string,
  feedback?: string
): Promise<FeedConfig> {
  const token = process.env.OPENROUTER_API_KEY;
  if (!token) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Required for OpenRouter config generation."
    );
  }

  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const truncated =
    cleaned.length > MAX_HTML_CHARS
      ? cleaned.slice(0, MAX_HTML_CHARS) + "\n<!-- truncated -->"
      : cleaned;

  let lastError = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const preamble =
      attempt === 0
        ? feedback
          ? `${feedback}\n\nAnalyze this blog page and output a corrected FeedConfig JSON.`
          : `Analyze this blog page and output a FeedConfig JSON.`
        : `Previous attempt failed: ${lastError}\n\nPlease fix and try again.`;
    const userPrompt = `${preamble}\n\nURL: ${url}\n\nHTML:\n${truncated}`;

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/leontloveless/ai-rss-feeds",
          "X-Title": "ai-rss-feeds",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 2000,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty response from API");

      const config = JSON.parse(content) as FeedConfig;

      if (!config.name || !config.url || !config.selectors?.articleList) {
        throw new Error(
          "Invalid config: missing required fields (name, url, selectors.articleList)"
        );
      }

      return config;
    } catch (err) {
      lastError = (err as Error).message;
      console.error(
        `  ⚠️ LLM attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError}`
      );
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw new Error(
    `Failed to generate config after ${MAX_RETRIES} attempts: ${lastError}`
  );
}
