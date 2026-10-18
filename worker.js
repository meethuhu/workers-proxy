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
    let target;
    try {
      target = resolveTarget(env);
    } catch (error) {
      console.error("TARGET_ORIGIN 配置无效", {
        value: env?.TARGET_ORIGIN,
        error: error instanceof Error ? error.message : String(error),
      });

      return new Response("500 Internal Server Error: 上游地址配置无效", {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const proxyUrl = new URL(request.url);
    const upstreamUrl = new URL(request.url);
    upstreamUrl.protocol = target.url.protocol;
    upstreamUrl.hostname = target.url.hostname;
    upstreamUrl.port = target.url.port;

    const upstreamRequestInit = {
      method: request.method,
      headers: buildUpstreamHeaders(request, proxyUrl, target),
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      upstreamRequestInit.body = request.body;
    }

    // 超时只约束「等待响应头」这一段。若用 AbortSignal.timeout，
    // 计时器会一直活到请求结束，25s 时把仍在传输的响应体一起中断，
    // 大文件下载会在中途失败。因此拿到响应头后立刻清除计时器。
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, target.timeoutMs);

    try {
      const response = await fetch(upstreamUrl, {
        ...upstreamRequestInit,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const responseHeaders = buildResponseHeaders(response, proxyUrl, target);
      const contentType = responseHeaders.get("content-type") || "";

      // 只有未压缩的 HTML 才能当文本改写。压缩过的 body 是二进制字节，
      // 按文本逐字符处理会静默损坏内容，所以原样透传并保留 content-encoding。
      if (
        isHtmlResponse(contentType) &&
        response.body &&
        isIdentityEncoding(responseHeaders.get("content-encoding")) &&
        !isPartialContent(response)
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
      clearTimeout(timeoutId);

      // 详细原因只写日志，不回传客户端，避免泄漏上游地址与网络错误细节。
      console.error("上游请求失败", {
        url: upstreamUrl.href,
        method: request.method,
        timedOut,
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

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议: ${url.protocol}`);
  }

  // 可选：env.UPSTREAM_TIMEOUT_MS 覆盖等待响应头的超时（默认 25s）
  const configured = Number(env?.UPSTREAM_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : UPSTREAM_TIMEOUT_MS;

  return { url, origin: url.origin, host: url.host, timeoutMs };
}

function buildUpstreamHeaders(request, proxyUrl, target) {
  const headers = new Headers(request.headers);

  for (const header of [...REQUEST_HEADERS_TO_DROP, ...HOP_BY_HOP_HEADERS]) {
    headers.delete(header);
  }

  headers.set("host", target.host);

  // 只有可能返回 HTML 的请求才需要禁止压缩，因为 body 要按文本改写。
  // 其余请求（JS / CSS / 字体 / 图片）透传客户端的 accept-encoding，
  // 避免为了改写文档而牺牲全部静态资源的压缩传输。
  if (mayReturnHtml(request)) {
    headers.set("accept-encoding", "identity");
  }

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

function mayReturnHtml(request) {
  // Sec-Fetch-Dest 由浏览器自动带上，比 Accept 更精确：
  // 导航请求为 document，iframe 为 iframe，静态资源为 image / style / script 等。
  const destination = request.headers.get("sec-fetch-dest");
  if (destination) {
    return destination === "document" || destination === "iframe" || destination === "frame";
  }

  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html") || accept.includes("application/xhtml");
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
  // 带 crossorigin 的 <script integrity> 会走 CORS 校验，
  // 回显上游域名的 ACAO 会让这些资源被浏览器拒绝。
  rewriteHeader(headers, "access-control-allow-origin", proxyUrl, target);
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

function isPartialContent(response) {
  // 206 的 body 只是完整资源的一段切片，按文本改写会破坏 Content-Range
  // 描述的字节区间，因此分段响应一律原样透传。
  return response.status === 206 || response.headers.has("content-range");
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
  const replacementByNeedle = new Map(replacements);
  const maxNeedleLength = Math.max(...replacements.map(([needle]) => needle.length));

  // 用单个正则一次扫描代替逐字符 startsWith：
  // 前者由引擎实现，后者在 1MB 页面上要多花一个数量级的 CPU。
  const pattern = new RegExp(
    replacements.map(([needle]) => escapeRegExp(needle)).join("|"),
    "g",
  );

  return (value, isFinal) => {
    // 末尾 maxNeedleLength - 1 个字符可能是被切断的匹配，留给下一块拼接
    const cut = isFinal
      ? value.length
      : Math.max(0, value.length - maxNeedleLength + 1);

    let output = "";
    let last = 0;
    let match;

    pattern.lastIndex = 0;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index >= cut) {
        break;
      }

      output += value.slice(last, match.index) + replacementByNeedle.get(match[0]);
      last = match.index + match[0].length;
    }

    const consumed = Math.max(last, cut);
    output += value.slice(last, consumed);

    return {
      output,
      carry: value.slice(consumed),
    };
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeSlashes(value) {
  return value.replaceAll("/", "\\/");
}

function rewriteTargetReferencesToProxy(value, proxyUrl, target) {
  return getTargetToProxyReplacements(proxyUrl, target).reduce(
    (rewritten, [needle, replacement]) => rewritten.replaceAll(needle, replacement),
    value,
  );
}

function getTargetToProxyReplacements(proxyUrl, target) {
  const proxyOrigin = proxyUrl.origin;
  const proxyHost = proxyUrl.host;

  const replacements = [
    [target.origin, proxyOrigin],
    [`http://${target.host}`, proxyOrigin],
    [`//${target.host}`, `//${proxyHost}`],
    // 页面内联的 JSON / JS 常把斜杠转义成 \/，不处理会导致这些地址漏改
    [escapeSlashes(target.origin), escapeSlashes(proxyOrigin)],
    [`http:\\/\\/${target.host}`, escapeSlashes(proxyOrigin)],
    [`\\/\\/${target.host}`, `\\/\\/${proxyHost}`],
  ];

  // 长 needle 优先，保证 https://host 不会被 //host 抢先匹配
  return replacements.sort((a, b) => b[0].length - a[0].length);
}

function rewriteProxyReferencesToTarget(value, proxyUrl, target) {
  const replacements = getTargetToProxyReplacements(proxyUrl, target)
    .map(([needle, replacement]) => [replacement, needle])
    .sort((a, b) => b[0].length - a[0].length);

  return replacements.reduce(
    (rewritten, [needle, replacement]) => rewritten.replaceAll(needle, replacement),
    value,
  );
}
