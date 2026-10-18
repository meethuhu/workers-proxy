import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import worker from "../worker.js";

const PROXY_ORIGIN = "https://proxy.example.workers.dev";
const PROXY_HOST = "proxy.example.workers.dev";
const UPSTREAM_ORIGIN = "https://spring.io";
const UPSTREAM_HOST = "spring.io";

const originalFetch = globalThis.fetch;
let captured;

function mockUpstream(handler) {
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return handler(url, init);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  captured = undefined;
  mock.restoreAll();
});

function proxyRequest(path = "/", headers = {}) {
  return new Request(`${PROXY_ORIGIN}${path}`, { headers });
}

function htmlResponse(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function chunkedBody(bytes, chunkSize) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

function replaceAllTargets(html) {
  return html
    .replaceAll(UPSTREAM_ORIGIN, PROXY_ORIGIN)
    .replaceAll(`http://${UPSTREAM_HOST}`, PROXY_ORIGIN)
    .replaceAll(`//${UPSTREAM_HOST}`, `//${PROXY_HOST}`)
    .replaceAll(`https:\\/\\/${UPSTREAM_HOST}`, `https:\\/\\/${PROXY_HOST}`)
    .replaceAll(`\\/\\/${UPSTREAM_HOST}`, `\\/\\/${PROXY_HOST}`);
}

test("改写绝对地址与协议相对地址，并移除 content-length", async () => {
  mockUpstream(() =>
    htmlResponse(
      `<a href="${UPSTREAM_ORIGIN}/pay">1</a><img src="//${UPSTREAM_HOST}/b.png">`,
    ),
  );

  const res = await worker.fetch(proxyRequest("/pay"), {});
  const text = await res.text();

  assert.ok(text.includes(`${PROXY_ORIGIN}/pay`), "绝对地址未改写");
  assert.ok(text.includes(`//${PROXY_HOST}/b.png`), "协议相对地址未改写");
  assert.equal(res.headers.get("content-length"), null);
});

test("改写内联 JSON 中转义斜杠的地址", async () => {
  const html = `<script>var u="https:\\/\\/${UPSTREAM_HOST}\\/api";</script>`;
  mockUpstream(() => htmlResponse(html));

  const res = await worker.fetch(proxyRequest("/"), {});
  const text = await res.text();

  assert.ok(
    text.includes(`https:\\/\\/${PROXY_HOST}\\/api`),
    `转义斜杠地址未改写: ${text}`,
  );
});

test("任意 chunk 切分下改写结果一致", async () => {
  const html =
    `<div><a href="${UPSTREAM_ORIGIN}/a">x</a>` +
    `<img src="//${UPSTREAM_HOST}/b.png">` +
    `<script>u="https:\\/\\/${UPSTREAM_HOST}\\/c"</script>` +
    `<a href="http://${UPSTREAM_HOST}/d">y</a></div>`;
  const expected = replaceAllTargets(html);
  const bytes = new TextEncoder().encode(html);

  for (const size of [1, 2, 3, 5, 7, 13, 26, 100, 4096]) {
    mockUpstream(
      () =>
        new Response(chunkedBody(bytes, size), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const res = await worker.fetch(proxyRequest("/"), {});
    assert.equal(await res.text(), expected, `chunkSize=${size} 时结果不一致`);
  }
});

test("按响应声明的字符集解码，并统一输出 UTF-8", async () => {
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
  const prefix = new TextEncoder().encode(`<a href="${UPSTREAM_ORIGIN}/p">`);
  const suffix = new TextEncoder().encode("</a>");
  const bytes = new Uint8Array([...prefix, ...gbk, ...suffix]);

  mockUpstream(
    () => new Response(bytes, { headers: { "content-type": "text/html; charset=gbk" } }),
  );

  const res = await worker.fetch(proxyRequest("/"), {});
  const text = await res.text();

  assert.ok(text.includes("中文"), "GBK 内容被解码成乱码");
  assert.ok(!text.includes("\uFFFD"), "出现替换字符 U+FFFD");
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});

test("压缩响应原样透传，不当作文本改写", async () => {
  const gzipped = gzipSync(Buffer.from(`<a href="${UPSTREAM_ORIGIN}">x</a>`));
  mockUpstream(
    () =>
      new Response(gzipped, {
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      }),
  );

  const res = await worker.fetch(proxyRequest("/"), {});
  const body = Buffer.from(await res.arrayBuffer());

  assert.deepEqual(body, gzipped, "压缩 body 被改动");
  assert.equal(res.headers.get("content-encoding"), "gzip");
});

test("文档请求禁用压缩，静态资源透传 accept-encoding", async () => {
  mockUpstream(() => htmlResponse("<p>ok</p>"));
  await worker.fetch(
    proxyRequest("/", { "sec-fetch-dest": "document", accept: "text/html" }),
    {},
  );
  assert.equal(captured.init.headers.get("accept-encoding"), "identity");

  mockUpstream(() => new Response("body{}", { headers: { "content-type": "text/css" } }));
  await worker.fetch(
    proxyRequest("/a.css", { "sec-fetch-dest": "style", "accept-encoding": "gzip, br" }),
    {},
  );
  assert.equal(captured.init.headers.get("accept-encoding"), "gzip, br");
});

test("没有 Sec-Fetch-Dest 时按 Accept 判断是否需要改写", async () => {
  mockUpstream(() => htmlResponse("<p>ok</p>"));
  await worker.fetch(proxyRequest("/", { accept: "text/html,application/xhtml+xml" }), {});
  assert.equal(captured.init.headers.get("accept-encoding"), "identity");
});

test("回显上游域名的 access-control-allow-origin 会被改写", async () => {
  mockUpstream(
    () =>
      new Response("ok", {
        headers: {
          "content-type": "text/plain",
          "access-control-allow-origin": UPSTREAM_ORIGIN,
        },
      }),
  );

  const res = await worker.fetch(proxyRequest("/"), {});
  assert.equal(res.headers.get("access-control-allow-origin"), PROXY_ORIGIN);
});

test("通配符 access-control-allow-origin 保持不变", async () => {
  mockUpstream(
    () =>
      new Response("ok", {
        headers: { "content-type": "text/plain", "access-control-allow-origin": "*" },
      }),
  );

  const res = await worker.fetch(proxyRequest("/"), {});
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("非 HTML 响应不被改写", async () => {
  mockUpstream(
    () =>
      new Response(`{"url":"${UPSTREAM_ORIGIN}/api"}`, {
        headers: { "content-type": "application/json" },
      }),
  );

  const res = await worker.fetch(proxyRequest("/api"), {});
  assert.ok((await res.text()).includes(UPSTREAM_ORIGIN));
});

test("上游异常时返回 502 且不泄漏内部细节", async () => {
  mock.method(console, "error", () => {});
  mockUpstream(() => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:443");
  });

  const res = await worker.fetch(proxyRequest("/"), {});
  const text = await res.text();

  assert.equal(res.status, 502);
  assert.ok(!text.includes("10.0.0.5"), "响应泄漏了内部 IP");
  assert.ok(!text.includes("ECONNREFUSED"), "响应泄漏了底层错误");
});

test("TARGET_ORIGIN 非法时返回 500 且不发起上游请求", async () => {
  mock.method(console, "error", () => {});
  mockUpstream(() => htmlResponse("<p>ok</p>"));

  const res = await worker.fetch(proxyRequest("/"), { TARGET_ORIGIN: "not a url" });

  assert.equal(res.status, 500);
  assert.equal(captured, undefined, "配置非法时仍然发起了上游请求");
});

test("env.TARGET_ORIGIN 覆盖默认上游", async () => {
  mockUpstream(() => htmlResponse(`<a href="https://other.example.com/x">y</a>`));

  const res = await worker.fetch(proxyRequest("/"), {
    TARGET_ORIGIN: "https://other.example.com",
  });
  const text = await res.text();

  assert.equal(new URL(captured.url).host, "other.example.com");
  assert.ok(text.includes(`${PROXY_ORIGIN}/x`), "覆盖上游后地址未按新上游改写");
});

test("206 分段响应不做 HTML 改写", async () => {
  const partial = `<a href="${UPSTREAM_ORIGIN}/x">`;
  mockUpstream(
    () =>
      new Response(partial, {
        status: 206,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-range": "bytes 0-24/1000",
        },
      }),
  );

  const res = await worker.fetch(proxyRequest("/", { range: "bytes=0-24" }), {});

  assert.equal(res.status, 206);
  assert.equal(await res.text(), partial, "分段响应被改写了");
});

test("大体积二进制响应逐字节透传", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = i % 251;
  }

  mockUpstream(
    () =>
      new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
      }),
  );

  const res = await worker.fetch(proxyRequest("/download.bin"), {});
  const body = new Uint8Array(await res.arrayBuffer());

  assert.equal(body.length, bytes.length);
  assert.deepEqual(body, bytes, "二进制内容被改动");
  assert.equal(res.headers.get("content-length"), String(bytes.length));
});

test("拿到响应头后清除超时计时器，避免中断仍在传输的 body", async () => {
  mockUpstream(() => new Response("ok", { headers: { "content-type": "text/plain" } }));

  const originalClear = globalThis.clearTimeout;
  const spy = mock.method(globalThis, "clearTimeout", (id) => originalClear(id));

  await worker.fetch(proxyRequest("/"), {});

  assert.ok(spy.mock.callCount() >= 1, "响应头返回后未清除超时计时器");
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

test("上游响应头返回后，慢速 body 仍能完整传输", async () => {
  // 响应头立刻返回，body 需要 600ms 才传完
  const server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write("start");
    const timer = setInterval(() => res.write("x"), 60);
    setTimeout(() => {
      clearInterval(timer);
      res.end("done");
    }, 600);
  });

  try {
    globalThis.fetch = originalFetch;
    const res = await worker.fetch(proxyRequest("/download.bin"), {
      TARGET_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      UPSTREAM_TIMEOUT_MS: "100", // 远小于 body 传输耗时
    });

    const text = await res.text();
    assert.ok(text.startsWith("start"), "body 起始内容丢失");
    assert.ok(text.endsWith("done"), `body 在 ${text.length} 字节处被截断`);
  } finally {
    await closeServer(server);
  }
});

test("上游迟迟不返回响应头时按超时返回 502", async () => {
  mock.method(console, "error", () => {});
  const server = await listen(() => {
    // 故意不响应
  });

  try {
    globalThis.fetch = originalFetch;
    const res = await worker.fetch(proxyRequest("/"), {
      TARGET_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      UPSTREAM_TIMEOUT_MS: "100",
    });

    assert.equal(res.status, 502);
  } finally {
    await closeServer(server);
  }
});

test("Set-Cookie 去除 Domain，并保留多条 cookie 与 __Host- 前缀", async () => {
  mockUpstream(
    () =>
      new Response("ok", {
        headers: [
          ["content-type", "text/plain"],
          ["set-cookie", "sid=abc; Domain=spring.io; Path=/; Secure"],
          ["set-cookie", "__Host-token=xyz; Path=/; Secure"],
        ],
      }),
  );

  const res = await worker.fetch(proxyRequest("/"), {});
  const cookies = res.headers.getSetCookie();

  assert.equal(cookies.length, 2, "多条 Set-Cookie 未全部保留");
  assert.equal(cookies[0], "sid=abc; Path=/; Secure");
  assert.equal(cookies[1], "__Host-token=xyz; Path=/; Secure", "__Host- cookie 被破坏");
});

test("重定向的 Location 改写为代理地址，相对路径保持不变", async () => {
  mockUpstream(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: `${UPSTREAM_ORIGIN}/login` },
      }),
  );

  const absolute = await worker.fetch(proxyRequest("/private"), {});
  assert.equal(absolute.status, 302);
  assert.equal(absolute.headers.get("location"), `${PROXY_ORIGIN}/login`);

  mockUpstream(
    () => new Response(null, { status: 302, headers: { location: "/login" } }),
  );

  const relative = await worker.fetch(proxyRequest("/private"), {});
  assert.equal(relative.headers.get("location"), "/login");
});

test("转发请求时把 Referer 改回上游地址", async () => {
  mockUpstream(() => htmlResponse("<p>ok</p>"));

  await worker.fetch(proxyRequest("/a", { referer: `${PROXY_ORIGIN}/from` }), {});

  assert.equal(captured.init.headers.get("referer"), `${UPSTREAM_ORIGIN}/from`);
});

test("TARGET_ORIGIN 含路径时返回 500 且不发起请求", async () => {
  mock.method(console, "error", () => {});
  mockUpstream(() => htmlResponse("<p>ok</p>"));

  const res = await worker.fetch(proxyRequest("/"), {
    TARGET_ORIGIN: "https://example.com/base",
  });

  assert.equal(res.status, 500);
  assert.equal(captured, undefined, "配置非法时仍然发起了上游请求");
});
