// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

// Agent: Web search (multi-engine with fallback)
// Call: run_agent({script:"ya-search.js", args:["query","--limit=10"]})
// In: argv[2]=query; optional --limit=N
// Out: stdout: search results

const query = process.argv[2] || 'default';
const limit = Math.min(
  parseInt(
    (process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] ||
    process.env.YA_SEARCH_LIMIT, 10
  ) || 10,
  50
);
const engineArg = (process.argv.find(a => a.startsWith('--engine=')) || '').split('=')[1] || 'auto';
const TIMEOUT_MS = 10000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function mapResult(r) {
  return {
    title: (r.title || r.Title || '').trim(),
    url: (r.url || r.Url || r.link || r.Link || '').trim(),
    snippet: (r.snippet || r.Snippet || r.description || r.Description || '').trim()
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
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
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[0];
    const link = row.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetEl = row.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);
    if (link) {
      const title = link[2].replace(/<[^>]+>/g, '').trim();
      const url = link[1].replace(/&amp;/g, '&');
      const snippet = snippetEl ? snippetEl[1].replace(/<[^>]+>/g, '').trim() : '';
      if (title && url) results.push({ title, url, snippet });
    }
  }
  if (results.length === 0) throw new Error('No results parsed');
  return results.slice(0, limit);
}

async function searchViaDDGHTML() {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' }
  });
  const results = [];
  const resultBlocks = html.split(/<div[^>]*class="result__body"[^>]*>/i);
  for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
    const block = resultBlocks[i];
    const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    if (titleMatch && urlMatch) {
      results.push({
        title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
        url: urlMatch[1].replace(/&amp;/g, '&'),
        snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''
      });
    }
  }
  if (results.length === 0) throw new Error('No results parsed');
  return results;
}

async function searchViaDDGAPI() {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const txt = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  const data = JSON.parse(txt);
  const items = [];
  if (data.AbstractText && data.AbstractURL) {
    items.push({ title: data.Heading || 'Result', url: data.AbstractURL, snippet: data.AbstractText });
  }
  const gather = (topics) => {
    for (const t of topics) {
      if (t.Text && t.FirstURL) {
        items.push({ title: t.Text.split(' - ')[0] || 'Result', url: t.FirstURL, snippet: t.Text });
      }
      if (t.Topics) gather(t.Topics);
      if (items.length >= limit) break;
    }
  };
  if (Array.isArray(data.RelatedTopics)) gather(data.RelatedTopics);
  if (Array.isArray(data.Results)) {
    for (const r of data.Results) {
      if (r.Text && r.FirstURL) {
        items.push({ title: r.Text.split(' - ')[0] || 'Result', url: r.FirstURL, snippet: r.Text });
      }
      if (items.length >= limit) break;
    }
  }
  if (items.length === 0) throw new Error('No results');
  return items.slice(0, limit);
}

const engines = [
  { name: 'DDG Lite', fn: searchViaDDGLite },
  { name: 'DDG HTML', fn: searchViaDDGHTML },
  { name: 'DDG API', fn: searchViaDDGAPI },
];

const engineMap = {
  'ddg-lite': 0,
  'ddg-html': 1,
  'ddg-api': 2,
  duckduckgo: 1
};

(async () => {
  try {
    let results = null;
    const forcedIdx = engineMap[engineArg.toLowerCase()];
    if (forcedIdx !== undefined) {
      results = await engines[forcedIdx].fn();
    } else {
      for (const eng of engines) {
        try {
          results = await eng.fn();
          if (results && results.length > 0) break;
        } catch {
          continue;
        }
      }
    }
    if (!results || results.length === 0) throw new Error('All search engines failed');
    console.log(JSON.stringify(results));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();