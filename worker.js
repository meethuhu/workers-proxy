const DEFAULT_TARGET_ORIGIN = "https://spring.io";
const UPSTREAM_TIMEOUT_MS = 25_000;

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

// body 被改写后，这些头描述的已不再是实际内容
const BODY_REWRITE_HEADERS_TO_DROP = ["content-length", "content-md5", "etag"];

export default {
  async fetch(request, env) {
    const target = resolveTarget(env);
    const proxyUrl = new URL(request.url);
    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = target.url.protocol;
    upstreamUrl.hostname = target.url.hostname;
    upstreamUrl.port = target.url.port;

    const upstreamRequestInit = {
      method: request.method,
      headers: buildUpstreamHeaders(request, proxyUrl, target),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      upstreamRequestInit.body = request.body;
    }

    try {
      const response = await fetch(upstreamUrl, upstreamRequestInit);
      const responseHeaders = buildResponseHeaders(response, proxyUrl, target);
      const contentType = responseHeaders.get("content-type") || "";

      // 只有未压缩的 HTML 才能当文本改写。压缩过的 body 是二进制字节，
      // 按文本逐字符处理会静默损坏内容，所以原样透传并保留 content-encoding。
      if (
        isHtmlResponse(contentType) &&
        response.body &&
        isIdentityEncoding(responseHeaders.get("content-encoding"))
      ) {
        for (const header of BODY_REWRITE_HEADERS_TO_DROP) {
          responseHeaders.delete(header);
        }

        // 解码所用字符集必须与重新编码后的字节一致：统一输出 UTF-8 并同步响应头，
        // 否则 GBK 等页面会被解码成 U+FFFD，且头里的 charset 与实际字节不符。
        responseHeaders.set("content-type", withUtf8Charset(contentType));

        return new Response(
          rewriteHtmlBody(response.body, proxyUrl, target, getCharset(contentType)),
          {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          },
        );
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      // 详细原因只写日志，不回传客户端，避免泄漏上游地址与网络错误细节。
      console.error("上游请求失败", {
        url: upstreamUrl.href,
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
      });

      return new Response("502 Bad Gateway: 上游服务暂时不可用", {
        status: 502,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
  },
};

function resolveTarget(env) {
  const raw = env?.TARGET_ORIGIN || DEFAULT_TARGET_ORIGIN;
  const url = new URL(raw);
  return { url, origin: url.origin, host: url.host };
}

function buildUpstreamHeaders(request, proxyUrl, target) {
  const headers = new Headers(request.headers);

  for (const header of [...REQUEST_HEADERS_TO_DROP, ...HOP_BY_HOP_HEADERS]) {
    headers.delete(header);
  }

  headers.set("host", target.host);
  headers.set("accept-encoding", "identity");

  const referer = headers.get("referer");
  if (referer) {
    headers.set("referer", rewriteProxyReferencesToTarget(referer, proxyUrl, target));
  }

  const origin = headers.get("origin");
  if (origin) {
    headers.set("origin", target.origin);
  }

  return headers;
}

function buildResponseHeaders(response, proxyUrl, target) {
  const headers = new Headers(response.headers);

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  rewriteHeader(headers, "location", proxyUrl, target);
  rewriteHeader(headers, "content-location", proxyUrl, target);
  rewriteHeader(headers, "link", proxyUrl, target);
  rewriteHeader(headers, "refresh", proxyUrl, target);
  rewriteHeader(headers, "content-security-policy", proxyUrl, target);
  rewriteHeader(headers, "content-security-policy-report-only", proxyUrl, target);
  rewriteSetCookieHeaders(response.headers, headers);

  return headers;
}

function rewriteHeader(headers, name, proxyUrl, target) {
  const value = headers.get(name);
  if (value) {
    headers.set(name, rewriteTargetReferencesToProxy(value, proxyUrl, target));
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

function isIdentityEncoding(contentEncoding) {
  if (!contentEncoding) {
    return true;
  }
  return contentEncoding.trim().toLowerCase() === "identity";
}

function getCharset(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match ? match[1].toLowerCase() : "utf-8";
}

function withUtf8Charset(contentType) {
  const mediaType = contentType.split(";")[0].trim();
  return `${mediaType || "text/html"}; charset=utf-8`;
}

function createDecoder(charset) {
  try {
    return new TextDecoder(charset, { fatal: false });
  } catch {
    // 未知或运行时未实现的字符集，退回 UTF-8，避免直接抛错中断响应
    return new TextDecoder("utf-8");
  }
}

function rewriteHtmlBody(body, proxyUrl, target, charset) {
  const decoder = createDecoder(charset);
  const encoder = new TextEncoder();
  const rewriteChunk = createStreamingReferenceRewriter(proxyUrl, target);
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

function createStreamingReferenceRewriter(proxyUrl, target) {
  const replacements = getTargetToProxyReplacements(proxyUrl, target);
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

function rewriteTargetReferencesToProxy(value, proxyUrl, target) {
  return getTargetToProxyReplacements(proxyUrl, target).reduce(
    (rewritten, [needle, replacement]) => rewritten.replaceAll(needle, replacement),
    value,
  );
}

function getTargetToProxyReplacements(proxyUrl, target) {
  // 按长度降序，保证 https://host 先于 //host 命中，不依赖数组书写顺序
  return [
    [target.origin, proxyUrl.origin],
    [`http://${target.host}`, proxyUrl.origin],
    [`//${target.host}`, `//${proxyUrl.host}`],
  ].sort((a, b) => b[0].length - a[0].length);
}

function rewriteProxyReferencesToTarget(value, proxyUrl, target) {
  return value
    .replaceAll(proxyUrl.origin, target.origin)
    .replaceAll(`http://${proxyUrl.host}`, target.origin)
    .replaceAll(`//${proxyUrl.host}`, `//${target.host}`);
}
