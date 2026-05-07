import { spawn } from 'node:child_process';

export type DiscoveredStream = {
  url: string;
  type: 'hls' | 'dash' | 'direct' | 'ytdlp';
  source: string; // human-readable origin: "html-scan", "yt-dlp", etc.
  title?: string;
  hasVideo?: boolean;
  hasAudio?: boolean;
};

/**
 * Discover playable audio/video streams from a user-supplied URL.
 *
 * Strategy:
 *  1. If the URL itself ends in .m3u8 / .mpd, return it directly.
 *  2. Fetch the page HTML and scan for embedded manifest URLs.
 *  3. If nothing found, fall back to yt-dlp (handles YouTube, Twitch,
 *     Vimeo, Kick, hundreds of other sites).
 */
export async function discoverStreams(inputUrl: string): Promise<DiscoveredStream[]> {
  const url = inputUrl.trim();

  // Validate scheme up front so we don't pass garbage to fetch/yt-dlp
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }

  // Direct manifest URL? Use it.
  if (/\.m3u8(\?|$)/i.test(url)) {
    return [{ url, type: 'hls', source: 'direct-manifest' }];
  }
  if (/\.mpd(\?|$)/i.test(url)) {
    return [{ url, type: 'dash', source: 'direct-manifest' }];
  }

  // HTML scan — first the page itself, then likely-player URLs it links to
  const fromHtml = await scanHtmlForStreams(url);
  if (fromHtml.length > 0) return fromHtml;

  const followUps = await scanHtmlForPlayerLinks(url);
  for (const followUrl of followUps) {
    const found = await scanHtmlForStreams(followUrl);
    if (found.length > 0) return found;
  }

  // yt-dlp fallback for YouTube/Twitch/etc.
  const fromYtdlp = await tryYtDlp(url);
  if (fromYtdlp.length > 0) return fromYtdlp;

  return [];
}

/**
 * If the initial page didn't contain manifest URLs, look for links to
 * player/stream/live/tv pages and iframes — those often hold the real
 * stream. We follow at most a few candidates to keep latency reasonable.
 */
async function scanHtmlForPlayerLinks(pageUrl: string): Promise<string[]> {
  let html: string;
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  const base = new URL(pageUrl);
  const candidates = new Set<string>();

  // <iframe src="..."> — common for embedded players
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    candidates.add(resolve(m[1], base));
  }

  // <a href="..."> where the URL hints at video/live/player/tv/stream
  const hintRe = /\b(live|player|stream|watch|tv|ott|broadcast)\b/i;
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    const href = m[1];
    if (hintRe.test(href)) candidates.add(resolve(href, base));
  }

  // Limit to first 5 same- or sub-domain candidates (avoid scanning the whole web)
  const baseHost = base.hostname.replace(/^www\./, '');
  return Array.from(candidates)
    .filter((u) => {
      try {
        const h = new URL(u).hostname.replace(/^www\./, '');
        return h === baseHost || h.endsWith('.' + baseHost) || baseHost.endsWith('.' + h);
      } catch {
        return false;
      }
    })
    .slice(0, 5);
}

function resolve(href: string, base: URL): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

async function scanHtmlForStreams(pageUrl: string): Promise<DiscoveredStream[]> {
  let html: string;
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  const found = new Map<string, DiscoveredStream>();

  // m3u8 / mpd matches, including escaped JSON variants ("https:\/\/...")
  const patterns = [
    { re: /https?:\\?\/\\?\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi, type: 'hls' as const },
    { re: /https?:\\?\/\\?\/[^\s"'<>\\]+?\.mpd[^\s"'<>\\]*/gi, type: 'dash' as const },
  ];

  for (const { re, type } of patterns) {
    for (const match of html.matchAll(re)) {
      const cleaned = match[0].replace(/\\\//g, '/');
      if (!found.has(cleaned)) {
        found.set(cleaned, { url: cleaned, type, source: 'html-scan' });
      }
    }
  }

  // Extract a page title for context
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  if (title) {
    for (const stream of found.values()) stream.title = title;
  }

  return Array.from(found.values());
}

async function tryYtDlp(url: string): Promise<DiscoveredStream[]> {
  // Check yt-dlp is on PATH first; fail fast and quiet otherwise
  const available = await new Promise<boolean>((resolve) => {
    const proc = spawn('yt-dlp', ['--version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
  if (!available) return [];

  // Ask yt-dlp for JSON metadata; -j prints one JSON line per entry.
  // We pick the best combined audio+video URL it can resolve.
  const json = await new Promise<string>((resolve, reject) => {
    const args = [
      '-j',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      '-f', 'best',
      url,
    ];
    const proc = spawn('yt-dlp', args, { timeout: 30_000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `yt-dlp exited ${code}`));
    });
  }).catch(() => '');

  if (!json) return [];

  const results: DiscoveredStream[] = [];
  for (const line of json.split('\n').filter(Boolean)) {
    try {
      const info = JSON.parse(line);
      if (info.url) {
        results.push({
          url: info.url,
          type: 'ytdlp',
          source: `yt-dlp (${info.extractor || 'unknown'})`,
          title: info.title,
          hasVideo: info.vcodec && info.vcodec !== 'none',
          hasAudio: info.acodec && info.acodec !== 'none',
        });
      }
    } catch {
      // skip unparseable lines
    }
  }
  return results;
}
