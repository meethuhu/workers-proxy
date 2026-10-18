const TARGET_ORIGIN = "https://spring.io";
const TARGET_URL = new URL(TARGET_ORIGIN);
const TARGET_HOST = TARGET_URL.host;

const REQUEST_HEADERS_TO_DROP = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cdn-loop",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const BODY_REWRITE_HEADERS_TO_DROP = [
  "content-encoding",
  "content-length",
  "content-md5",
  "etag",
];

export default {
  async fetch(request) {
    const proxyUrl = new URL(request.url);
    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = TARGET_URL.protocol;
    upstreamUrl.hostname = TARGET_URL.hostname;
    upstreamUrl.port = TARGET_URL.port;

    const upstreamHeaders = buildUpstreamHeaders(request, proxyUrl);
    const upstreamRequestInit = {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      upstreamRequestInit.body = request.body;
    }

    try {
      const response = await fetch(new Request(upstreamUrl, upstreamRequestInit));
      const responseHeaders = buildResponseHeaders(response, proxyUrl);
      const contentType = responseHeaders.get("content-type") || "";

      if (isHtmlResponse(contentType) && response.body) {
        for (const header of BODY_REWRITE_HEADERS_TO_DROP) {
          responseHeaders.delete(header);
        }

        return new Response(rewriteHtmlBody(response.body, proxyUrl), {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`反向代理请求失败: ${message}`, {
        status: 502,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
  },
};

function buildUpstreamHeaders(request, proxyUrl) {
  const headers = new Headers(request.headers);

  for (const header of [...REQUEST_HEADERS_TO_DROP, ...HOP_BY_HOP_HEADERS]) {
    headers.delete(header);
  }

  headers.set("host", TARGET_HOST);
  headers.set("accept-encoding", "identity");

  const referer = headers.get("referer");
  if (referer) {
    headers.set("referer", rewriteProxyReferencesToTarget(referer, proxyUrl));
  }

  const origin = headers.get("origin");
  if (origin) {
    headers.set("origin", TARGET_ORIGIN);
  }

  return headers;
}

function buildResponseHeaders(response, proxyUrl) {
  const headers = new Headers(response.headers);

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  rewriteHeader(headers, "location", proxyUrl);
  rewriteHeader(headers, "content-location", proxyUrl);
  rewriteHeader(headers, "link", proxyUrl);
  rewriteHeader(headers, "refresh", proxyUrl);
  rewriteHeader(headers, "content-security-policy", proxyUrl);
  rewriteHeader(headers, "content-security-policy-report-only", proxyUrl);
  rewriteSetCookieHeaders(response.headers, headers);

  return headers;
}

function rewriteHeader(headers, name, proxyUrl) {
  const value = headers.get(name);
  if (value) {
    headers.set(name, rewriteTargetReferencesToProxy(value, proxyUrl));
  }
}

function rewriteSetCookieHeaders(sourceHeaders, responseHeaders) {
  const cookies = getSetCookies(sourceHeaders);
  responseHeaders.delete("set-cookie");

  for (const cookie of cookies) {
    responseHeaders.append("set-cookie", rewriteSetCookie(cookie));
  }
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  if (typeof headers.getAll === "function") {
    return headers.getAll("set-cookie");
  }

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function rewriteSetCookie(cookie) {
  // Drop Domain instead of adding the proxy host. This keeps cookies host-only
  // and preserves __Host- cookies, which are invalid if Domain is present.
  return cookie.replace(/;\s*domain=[^;]*/gi, "");
}

function isHtmlResponse(contentType) {
  return contentType.toLowerCase().includes("text/html");
}

function rewriteHtmlBody(body, proxyUrl) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const rewriteChunk = createStreamingReferenceRewriter(proxyUrl);
  let carry = "";

  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      const rewritten = rewriteChunk(text, false);

      if (rewritten.output) {
        controller.enqueue(encoder.encode(rewritten.output));
      }
      carry = rewritten.carry;
    },

    flush(controller) {
      const text = carry + decoder.decode();
      const rewritten = rewriteChunk(text, true);
      if (rewritten.output) {
        controller.enqueue(encoder.encode(rewritten.output));
      }
    },
  }));
}

function createStreamingReferenceRewriter(proxyUrl) {
  const replacements = getTargetToProxyReplacements(proxyUrl);
  const maxNeedleLength = Math.max(...replacements.map(([needle]) => needle.length));

  return (value, isFinal) => {
    const safeEnd = isFinal
      ? value.length
      : Math.max(0, value.length - maxNeedleLength + 1);
    let output = "";
    let index = 0;

    while (index < safeEnd) {
      const replacement = replacements.find(([needle]) => value.startsWith(needle, index));
      if (replacement) {
        output += replacement[1];
        index += replacement[0].length;
        continue;
      }

      output += value[index];
      index += 1;
    }

    return {
      output,
      carry: value.slice(index),
    };
  };
}

function rewriteTargetReferencesToProxy(value, proxyUrl) {
  return getTargetToProxyReplacements(proxyUrl).reduce(
    (rewritten, [needle, replacement]) => rewritten.replaceAll(needle, replacement),
    value,
  );
}

function getTargetToProxyReplacements(proxyUrl) {
  return [
    [TARGET_ORIGIN, proxyUrl.origin],
    [`http://${TARGET_HOST}`, proxyUrl.origin],
    [`//${TARGET_HOST}`, `//${proxyUrl.host}`],
  ];
}

function rewriteProxyReferencesToTarget(value, proxyUrl) {
  return value
    .replaceAll(proxyUrl.origin, TARGET_ORIGIN)
    .replaceAll(`http://${proxyUrl.host}`, TARGET_ORIGIN)
    .replaceAll(`//${proxyUrl.host}`, `//${TARGET_HOST}`);
}
