// ─── Constants ───────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const FETCH_TIMEOUT_MS = 10_000;
const BLOCKED_HOSTNAMES = [
  "localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254",
  "metadata.google.internal",
];
const BLOCKED_IP_PREFIXES = ["10.", "192.168.", "172.16.", "172.17.",
  "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.",
  "172.30.", "172.31.", "169.254."];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent",
  "Access-Control-Max-Age": "86400",
};

// ─── Main Worker ────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return jsonResponse(200, {
        status: "Advanced Scraper Active 🚀",
        message: "Provide a target video page using the ?url= parameter.",
      });
    }

    // ── Input validation (S1, S2, C1) ──
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return jsonResponse(400, { success: false, error: "Invalid URL format." });
    }

    if (parsedTarget.protocol !== "https:" && parsedTarget.protocol !== "http:") {
      return jsonResponse(400, { success: false, error: "Only http/https URLs are allowed." });
    }

    const hostname = parsedTarget.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.includes(hostname) ||
        BLOCKED_IP_PREFIXES.some((p) => hostname.startsWith(p))) {
      return jsonResponse(403, { success: false, error: "Target hostname is blocked (SSRF protection)." });
    }

    // ── Fetch with timeout (P2) ──
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      return jsonResponse(504, { success: false, error: `Fetch failed: ${err.message}` });
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      return jsonResponse(502, {
        success: false,
        error: `Target returned status ${response.status}`,
      });
    }

    // ── Stream-parse with HTMLRewriter + size limit (P1, S3) ──
    const accumulatedScripts = [];
    let currentScriptText = "";
    let totalBytes = 0;

    const rewriter = new HTMLRewriter().on("script", {
      text(textNode) {
        const chunk = textNode.text;
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          textNode.remove();
          return;
        }
        currentScriptText += chunk;
        if (textNode.lastInTextNode) {
          if (currentScriptText.trim()) {
            accumulatedScripts.push(currentScriptText);
          }
          currentScriptText = "";
        }
      },
    });

    const transformedResponse = rewriter.transform(response);
    await transformedResponse.text();

    // ── Extract video URLs ──
    let extractedVideoUrls = [];
    let wasUnpacked = false;

    for (const scriptContent of accumulatedScripts) {
      if (detectPacker(scriptContent)) {
        try {
          const unpackedSource = unpackScript(scriptContent);
          wasUnpacked = true; // (B2 fix)
          const foundUrls = extractMediaEndpoints(unpackedSource);
          if (foundUrls.length > 0) extractedVideoUrls.push(...foundUrls);
        } catch {
          continue;
        }
      } else {
        const foundUrls = extractMediaEndpoints(scriptContent);
        if (foundUrls.length > 0) extractedVideoUrls.push(...foundUrls);
      }
    }

    const uniqueUrls = [...new Set(extractedVideoUrls)];

    return jsonResponse(200, {
      success: uniqueUrls.length > 0,
      target: targetUrl,
      media_count: uniqueUrls.length,
      urls: uniqueUrls,
      direct_url: uniqueUrls[0] || null,
      direct_urls: uniqueUrls,
      unpacked: wasUnpacked,
    });
  },
};

// ─── Helper: JSON response with CORS ──────────────────────
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

// ─── Packer detection ──────────────────────────────────────
function detectPacker(source) {
  const clean = source.replace(/\s+/g, "");
  return clean.includes("eval(function(p,a,c,k,e,") ||
         clean.includes("eval(function(p,r,o,x,y,");
}

// ─── Non-evaluative unpacking ──────────────────────────────
function unpackScript(source) {
  const pattern = /\}\s*\(\s*(['"`])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"`])([\s\S]*?)\5\s*\.split\s*\(\s*(['"`])(.*?)\7\s*\)/;
  const match = source.match(pattern);
  if (!match) throw new Error("Unable to parse packed parameters.");

  const payload = match[2];
  const radix = parseInt(match[3], 10);
  const count = parseInt(match[4], 10);
  const delimiter = match[8];
  const symtab = match[6].split(delimiter);

  if (count !== symtab.length) throw new Error("Symtab count mismatch.");

  const unbase = getUnbaser(radix);
  const lookup = (word) => symtab[unbase(word)] || word;

  return payload.replace(/\b\w+\b/g, lookup).replace(/\\/g, "");
}

// ─── Radix converter (B4: supports up to base 95) ─────────
function getUnbaser(radix) {
  if (radix >= 2 && radix <= 36) {
    return (str) => parseInt(str, radix);
  }

  // Full printable ASCII for bases up to 95 (B4 fix)
  const alphabet = radix <= 62
    ? "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    : '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

  const dictionary = {};
  for (let i = 0; i < Math.min(radix, alphabet.length); i++) {
    dictionary[alphabet[i]] = i;
  }

  return (str) => str.split("").reverse().reduce((acc, char, idx) => {
    const val = dictionary[char];
    return val === undefined ? acc : acc + val * Math.pow(radix, idx);
  }, 0);
}

// ─── Media URL extraction ──────────────────────────────────
function extractMediaEndpoints(text) {
  const pattern = /(https?:\/\/[^\s'"`<>]+?\.(?:mp4|m3u8|mpd|webm)(?:\?[^\s'"`<>]*)?)/gi;
  return text.match(pattern) || [];
}
