// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Keyless web search (fallback chain)
// Call: run_agent({script:"web-search.js", args:["query","--limit=10"]})
// In: argv[2]=query; optional --limit=N, --engine=ddg-lite|ddg-html|wikipedia
// Out: stdout: JSON [{title,url,snippet}] (empty array only with --engine forced)
//
// Honest contract: this is a KEYLESS fallback, not a search API. Datacenter
// IPs get anti-bot pages from most engines, so the chain tries DuckDuckGo
// first (works from residential networks) and falls back to the Wikipedia
// API (always reachable, encyclopedic scope only). For production-quality
// web search configure the gateway `search` tool (Tavily / SearXNG).

const query = process.argv[2] || 'default';
const limit = Math.min(
  parseInt(
    (process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] ||
    process.env.WEB_SEARCH_LIMIT, 10
  ) || 10,
  50
);
const engineArg = (process.argv.find(a => a.startsWith('--engine=')) || '').split('=')[1] || 'auto';
const TIMEOUT_MS = 12000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    // Anti-bot interstitials parse as zero results — fail loudly so the
    // chain moves on instead of returning a garbage page.
    if (/anomaly|captcha|are you a robot|verify you are human/i.test(body.slice(0, 4000))) {
      throw new Error('bot-check page');
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchViaDDGLite() {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const html = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  const results = [];
  const links = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of links) {
    const title = stripTags(m[2]);
    const href = m[1];
    if (!title || href.includes('duckduckgo.com')) continue;
    results.push({ title, url: href, snippet: '' });
    if (results.length >= limit) break;
  }
  if (results.length === 0) throw new Error('No results parsed');
  return results;
}

async function searchViaDDGHTML() {
  // POST form is blocked noticeably less than GET scraping.
  const body = new URLSearchParams({ q: query }).toString();
  const html = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const results = [];
  const blocks = html.split(/<div[^>]*class="result__body"[^>]*>/i);
  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const titleMatch = blocks[i].match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const urlMatch = blocks[i].match(/href="(https?:\/\/[^"]+)"/i);
    const snippetMatch = blocks[i].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    if (titleMatch && urlMatch) {
      results.push({
        title: stripTags(titleMatch[1]),
        url: urlMatch[1],
        snippet: snippetMatch ? stripTags(snippetMatch[1]) : ''
      });
    }
  }
  if (results.length === 0) throw new Error('No results parsed');
  return results;
}

async function searchViaWikipedia() {
  const lang = /[А-Яа-яЁё]/.test(query) ? 'ru' : 'en';
  const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&format=json&redirects=resolve`;
  const txt = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  const data = JSON.parse(txt);
  const titles = data[1] ?? [];
  const urls = data[3] ?? [];
  const items = titles.map((t, i) => ({ title: t, url: urls[i] ?? '', snippet: '' }));
  if (items.length === 0) throw new Error('No results');
  return items;
}

const engines = [
  { name: 'ddg-lite', fn: searchViaDDGLite },
  { name: 'ddg-html', fn: searchViaDDGHTML },
  { name: 'wikipedia', fn: searchViaWikipedia },
];

const engineMap = { 'ddg-lite': 0, 'ddg-html': 1, wikipedia: 2 };

(async () => {
  try {
    let results = null;
    let usedEngine = '';
    const forcedIdx = engineMap[engineArg.toLowerCase()];
    if (forcedIdx !== undefined) {
      results = await engines[forcedIdx].fn();
      usedEngine = engines[forcedIdx].name;
    } else {
      // Collect the per-engine reasons: a bare "all failed" hides exactly
      // the diagnostics the caller needs (which engine hit a bot-check).
      const failures = [];
      for (const eng of engines) {
        try {
          results = await eng.fn();
          if (results && results.length > 0) {
            usedEngine = eng.name;
            break;
          }
        } catch (e) {
          failures.push(`${eng.name}: ${e.message}`);
        }
      }
      if (!usedEngine && failures.length > 0) {
        throw new Error(
          `All engines failed (${failures.join("; ")}). ` +
          'Keyless search is best-effort (datacenter IPs get bot-checks): ' +
          'configure the gateway search tool (tools.tavily.apiKey / tools.searxng.url) for reliable results.'
        );
      }
    }
    if (!results || results.length === 0) {
      throw new Error('No results. Keyless search is best-effort: configure the gateway search tool (Tavily/SearXNG) for reliable results.');
    }
    console.log(JSON.stringify(results));
    console.error(`[web-search] engine=${usedEngine} results=${results.length}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
