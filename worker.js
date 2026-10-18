
/**
 * Cloudflare Workers — HLS / DASH Proxy (Testing)
 *
 * Endpoint:
 * /proxy?headers=URL_ENCODED_JSON&url=URL_ENCODED_URL
 *
 * Supports:
 * - HLS master and media playlists
 * - Nested variants, segments, keys, maps and subtitles
 * - DASH MPD, BaseURL and direct segment references
 * - Custom Referer, Origin, User-Agent and X-* headers
 * - GET/POST API requests (maximum 1 MB POST body)
 * - HTTP Range requests and streamed media responses
 * - Redirect handling, CORS and OPTIONS
 *
 * TESTING MODE:
 * Accepts localhost and private IP URLs at validation time.
 * Cloudflare networking may still prevent reaching them.
 *
 * Do not expose this unrestricted proxy publicly.
 */

const PROXY_PATH = "/proxy";
const MAX_MANIFEST_SIZE = 2_000_000;
const MAX_REDIRECTS = 5;
const MAX_API_BODY_SIZE = 1_000_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Range, If-Range, If-None-Match, Origin, Accept, Content-Type",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag",
  "Access-Control-Max-Age": "86400",
};

const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "set-cookie",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
]);

function reply(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...CORS,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/**
 * TESTING MODE: permits HTTP/HTTPS URLs regardless of hostname.
 *
 * This removes application-level private-network restrictions.
 * It does not guarantee that Cloudflare can route to the destination.
 */
function validateUrl(raw) {
  let target;

  try {
    target = new URL(raw);
  } catch {
    throw new Error("Invalid upstream URL");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }

  if (target.username || target.password) {
    throw new Error("Credentials inside URLs are not supported");
  }

  return target;
}

function parseHeaders(raw) {
  if (!raw) return {};

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid headers parameter. Supply URL-encoded JSON."
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("headers must be a JSON object");
  }

  const result = {};

  for (const [key, value] of Object.entries(parsed)) {
    const name = key.toLowerCase();

    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(key) ||
      BLOCKED_HEADERS.has(name) ||
      name.startsWith("sec-") ||
      name.startsWith("proxy-")
    ) {
      continue;
    }

    // Accept common browser headers and custom X-* headers.
    const permitted =
      new Set([
        "accept",
        "content-type",
        "accept-language",
        "authorization",
        "if-modified-since",
        "if-none-match",
        "if-range",
        "range",
        "referer",
        "origin",
        "user-agent",
        "x-requested-with",
      ]).has(name) || name.startsWith("x-");

    if (!permitted) continue;

    if (
      typeof value !== "string" ||
      /[\r\n]/.test(value) ||
      value.length > 4096
    ) {
      continue;
    }

    result[key] = value;
  }

  return result;
}

function resolveUri(uri, baseUrl) {
  const value = uri.trim();

  if (
    !value ||
    value.startsWith("#") ||
    /^(?:data|skd|urn|blob):/i.test(value)
  ) {
    return value;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function makeProxyUrl(workerOrigin, upstreamUrl, headers) {
  const result = new URL(PROXY_PATH, workerOrigin);

  result.searchParams.set("headers", JSON.stringify(headers));
  result.searchParams.set("url", upstreamUrl);

  return result.toString();
}

function rewriteHls(text, baseUrl, workerOrigin, headers) {
  // Rewrite URI attributes, including keys, initialization maps,
  // audio renditions, subtitles and alternate playlist references.
  let output = text.replace(
    /(\bURI\s*=\s*)"([^"]*)"/gi,
    (match, prefix, value) => {
      const resolved = resolveUri(value, baseUrl);

      if (!/^https?:\/\//i.test(resolved)) {
        return match;
      }

      try {
        validateUrl(resolved);

        return (
          prefix +
          '"' +
          makeProxyUrl(workerOrigin, resolved, headers) +
          '"'
        );
      } catch {
        return match;
      }
    }
  );

  // Rewrite master variants, nested playlists and media segments.
  output = output.replace(
    /^(?!\s*#)([^\r\n]+)$/gm,
    (line) => {
      const value = line.trim();

      if (!value) return line;

      const resolved = resolveUri(value, baseUrl);

      if (!/^https?:\/\//i.test(resolved)) {
        return line;
      }

      try {
        validateUrl(resolved);

        return line.replace(
          value,
          makeProxyUrl(workerOrigin, resolved, headers)
        );
      } catch {
        return line;
      }
    }
  );

  return output;
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rewriteDash(text, baseUrl, workerOrigin, headers) {
  let output = text;

  // Rewrite explicit BaseURL elements.
  output = output.replace(
    /(<BaseURL\b[^>]*>)([\s\S]*?)(<\/BaseURL\s*>)/gi,
    (match, open, content, close) => {
      const value = content.trim();

      if (!value || value.includes("<") || value.includes("$")) {
        return match;
      }

      const resolved = resolveUri(value, baseUrl);

      if (!/^https?:\/\//i.test(resolved)) {
        return match;
      }

      try {
        validateUrl(resolved);

        return (
          open +
          escapeXml(
            makeProxyUrl(workerOrigin, resolved, headers)
          ) +
          close
        );
      } catch {
        return match;
      }
    }
  );

  // Rewrite direct URL attributes. Template placeholders such as
  // $Number$ and $Time$ are deliberately left unchanged.
  output = output.replace(
    /\b(media|initialization|sourceURL|index|href)\s*=\s*"([^"]*)"/gi,
    (match, name, value) => {
      if (!value || value.includes("$")) {
        return match;
      }

      const resolved = resolveUri(value, baseUrl);

      if (!/^https?:\/\//i.test(resolved)) {
        return match;
      }

      try {
        validateUrl(resolved);

        return (
          name +
          '="' +
          escapeXml(
            makeProxyUrl(workerOrigin, resolved, headers)
          ) +
          '"'
        );
      } catch {
        return match;
      }
    }
  );

  return output;
}

function detectManifest(url, contentType, body) {
  const path = url.pathname.toLowerCase();
  const type = (contentType || "").toLowerCase();

  return (
    path.endsWith(".m3u8") ||
    path.endsWith(".mpd") ||
    type.includes("mpegurl") ||
    type.includes("dash+xml") ||
    body.trimStart().startsWith("#EXTM3U") ||
    /<MPD\b/i.test(body)
  );
}

function isDashManifest(url, contentType, body) {
  return (
    url.pathname.toLowerCase().endsWith(".mpd") ||
    (contentType || "").toLowerCase().includes("dash+xml") ||
    /<MPD\b/i.test(body)
  );
}

function buildUpstreamHeaders(customHeaders, request) {
  const headers = new Headers({
    Accept: "*/*",
  });

  for (const [name, value] of Object.entries(customHeaders)) {
    headers.set(name, value);
  }

  // Preserve playback byte-range and conditional requests.
  for (const name of ["range", "if-range", "if-none-match"]) {
    const value = request.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function fetchFollowingRedirects(
  target,
  method,
  headers,
  body
) {
  let currentUrl = target;
  let currentMethod = method;
  let currentBody = body;
  let redirects = 0;

  while (true) {
    const upstream = await fetch(currentUrl.toString(), {
      method: currentMethod,
      headers,
      ...(currentBody !== null && currentMethod !== "GET" && currentMethod !== "HEAD"
        ? { body: currentBody }
        : {}),
      redirect: "manual",
    });

    const location = upstream.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(upstream.status);

    if (!isRedirect || !location) {
      return {
        upstream,
        finalUrl: currentUrl,
      };
    }

    if (redirects >= MAX_REDIRECTS) {
      await upstream.body?.cancel();
      throw new Error("Too many upstream redirects");
    }

    let nextUrl;
    try {
      nextUrl = validateUrl(new URL(location, currentUrl).toString());
    } catch {
      await upstream.body?.cancel();
      throw new Error("Invalid redirect destination");
    }

    await upstream.body?.cancel();

    // Match browser redirect behavior for POST on 301/302/303.
    if (
      currentMethod === "POST" &&
      [301, 302, 303].includes(upstream.status)
    ) {
      currentMethod = "GET";
      currentBody = null;
      headers = new Headers(headers);
      headers.delete("content-type");
      headers.delete("content-length");
    }

    // Do not forward credentials across origins on redirects.
    if (nextUrl.origin !== currentUrl.origin) {
      headers = new Headers(headers);
      headers.delete("authorization");
      headers.delete("cookie");
    }

    currentUrl = nextUrl;
    redirects++;
  }
}

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    if (request.method === "OPTIONS") {
      return reply(null, 204);
    }

    if (incoming.pathname === "/") {
      return reply(
        JSON.stringify({
          service: "HLS/DASH Proxy",
          status: "online",
          mode: "testing",
          endpoint:
            "/proxy?headers=URL_ENCODED_JSON&url=URL_ENCODED_URL",
          formats: ["HLS", "M3U8", "DASH", "MPD", "JSON API POST"],
          methods: ["GET", "HEAD", "POST", "OPTIONS"],
          localDestinations: "URL validation permits them",
        }),
        200,
        {
          "Content-Type": "application/json; charset=utf-8",
        }
      );
    }

    if (incoming.pathname !== PROXY_PATH) {
      return reply("Not found", 404);
    }

    if (!["GET", "HEAD", "POST"].includes(request.method)) {
      return reply("Method not allowed", 405, {
        Allow: "GET, HEAD, POST, OPTIONS",
      });
    }

    const rawUrl = incoming.searchParams.get("url");

    if (!rawUrl) {
      return reply("Missing url parameter", 400);
    }

    let target;
    let customHeaders;

    try {
      target = validateUrl(rawUrl);
      customHeaders = parseHeaders(
        incoming.searchParams.get("headers")
      );
    } catch (error) {
      return reply(error.message, 400);
    }

    const upstreamHeaders = buildUpstreamHeaders(
      customHeaders,
      request
    );

    let requestBody = null;
    if (request.method === "POST") {
      const declaredLength = Number(request.headers.get("content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_API_BODY_SIZE) {
        return reply("Request body exceeds the 1 MB API limit", 413);
      }

      requestBody = await request.arrayBuffer();
      if (requestBody.byteLength > MAX_API_BODY_SIZE) {
        return reply("Request body exceeds the 1 MB API limit", 413);
      }
    }

    let upstream;
    let finalUrl;

    try {
      ({ upstream, finalUrl } = await fetchFollowingRedirects(
        target,
        request.method,
        upstreamHeaders,
        requestBody
      ));
    } catch (error) {
      return reply(
        error.message || "Upstream request failed",
        502
      );
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const path = finalUrl.pathname.toLowerCase();

    const inspectManifest =
      request.method === "GET" &&
      upstream.ok &&
      (
        path.endsWith(".m3u8") ||
        path.endsWith(".mpd") ||
        /mpegurl|dash\+xml/i.test(contentType)
      );

    if (inspectManifest) {
      let body;

      try {
        body = await upstream.text();
      } catch {
        return reply("Unable to read manifest", 502);
      }

      if (body.length > MAX_MANIFEST_SIZE) {
        return reply("Manifest exceeds the 2 MB limit", 413);
      }

      let rewritten = body;

      if (detectManifest(finalUrl, contentType, body)) {
        rewritten = isDashManifest(finalUrl, contentType, body)
          ? rewriteDash(
              body,
              finalUrl.toString(),
              incoming.origin,
              customHeaders
            )
          : rewriteHls(
              body,
              finalUrl.toString(),
              incoming.origin,
              customHeaders
            );
      }

      return reply(rewritten, upstream.status, {
        "Content-Type":
          contentType ||
          (
            path.endsWith(".mpd")
              ? "application/dash+xml"
              : "application/vnd.apple.mpegurl"
          ),
      });
    }

    // Stream media bodies instead of buffering entire video segments.
    const headers = new Headers(CORS);

    headers.set("Cache-Control", "no-store");

    for (const name of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(name);

      if (value) {
        headers.set(name, value);
      }
    }

    return new Response(
      request.method === "HEAD" ? null : upstream.body,
      {
        status: upstream.status,
        headers,
      }
    );
  },
};
