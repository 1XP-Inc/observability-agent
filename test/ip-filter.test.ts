import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { parseAllowList, ipFilterHook } from "../src/ip-filter";
import { authHook } from "../src/auth";
import { createMockConfig } from "./helpers";

const SECRET = "test-secret-key-for-testing-hs256";

function validToken() {
  return jwt.sign(
    { sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
    { algorithm: "HS256" },
  );
}

describe("parseAllowList", () => {
  it("단일 IPv4 주소를 등록한다", () => {
    const list = parseAllowList(["10.0.0.1"]);
    expect(list.check("10.0.0.1")).toBe(true);
    expect(list.check("10.0.0.2")).toBe(false);
  });

  it("CIDR 서브넷을 등록한다", () => {
    const list = parseAllowList(["192.168.1.0/24"]);
    expect(list.check("192.168.1.1")).toBe(true);
    expect(list.check("192.168.1.254")).toBe(true);
    expect(list.check("192.168.2.1")).toBe(false);
  });

  it("IPv6 주소를 등록한다", () => {
    const list = parseAllowList(["::1"]);
    expect(list.check("::1", "ipv6")).toBe(true);
    expect(list.check("::2", "ipv6")).toBe(false);
  });

  it("IPv6 CIDR을 등록한다", () => {
    const list = parseAllowList(["fe80::/10"]);
    expect(list.check("fe80::1", "ipv6")).toBe(true);
    expect(list.check("2001:db8::1", "ipv6")).toBe(false);
  });

  it("혼합 입력을 처리한다", () => {
    const list = parseAllowList(["10.0.0.1", "192.168.0.0/16", "::1"]);
    expect(list.check("10.0.0.1")).toBe(true);
    expect(list.check("192.168.1.1")).toBe(true);
    expect(list.check("::1", "ipv6")).toBe(true);
    expect(list.check("172.16.0.1")).toBe(false);
  });

  it("빈 배열이면 모든 IP를 거부한다", () => {
    const list = parseAllowList([]);
    expect(list.check("10.0.0.1")).toBe(false);
  });
});

describe("ipFilterHook", () => {
  function buildApp(allowedIps: string[]) {
    const config = createMockConfig({ jwtSecret: SECRET });
    const allowList = parseAllowList(allowedIps);
    const app = Fastify();

    app.addHook("onRequest", ipFilterHook(allowList));
    app.addHook("onRequest", authHook(config));

    app.get("/api/test", async () => ({ ok: true }));
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/livez", async () => ({ status: "ok" }));
    app.get("/readyz", async () => ({ status: "ok" }));
    app.get("/skill.md", async () => "# Skill");
    app.get("/.well-known/skill.md", async () => "# Skill");

    return app;
  }

  it("허용된 IP는 통과한다", async () => {
    const app = buildApp(["127.0.0.1"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("차단된 IP는 403을 반환한다", async () => {
    const app = buildApp(["10.0.0.1"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${validToken()}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ip_not_allowed");
    await app.close();
  });

  it("차단된 IP는 JWT 검증 전에 거부된다 (토큰 없이도 403)", async () => {
    const app = buildApp(["10.0.0.1"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ip_not_allowed");
    await app.close();
  });

  describe("스킵 경로는 IP 필터를 건너뛴다", () => {
    const skipPaths = [
      "/healthz",
      "/livez",
      "/readyz",
      "/skill.md",
      "/.well-known/skill.md",
    ];

    for (const p of skipPaths) {
      it(`${p} 는 차단 IP에서도 200을 반환한다`, async () => {
        const app = buildApp(["10.0.0.1"]); // 127.0.0.1은 허용 안 됨
        const res = await app.inject({ method: "GET", url: p });
        expect(res.statusCode).toBe(200);
        await app.close();
      });
    }
  });

  it("CIDR 허용 범위 내의 IP는 통과한다", async () => {
    const app = buildApp(["127.0.0.0/8"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("trustProxy 통합", () => {
  it("trustProxy=true 이면 X-Forwarded-For 헤더에서 IP를 추출한다", async () => {
    const config = createMockConfig({ jwtSecret: SECRET, trustProxy: true });
    const allowList = parseAllowList(["203.0.113.42"]);
    const app = Fastify({ trustProxy: config.trustProxy });

    app.addHook("onRequest", ipFilterHook(allowList));
    app.addHook("onRequest", authHook(config));
    app.get("/api/test", async () => ({ ok: true }));

    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: {
        "x-forwarded-for": "203.0.113.42",
        authorization: `Bearer ${validToken()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("trustProxy=true 이고 X-Forwarded-For 가 차단 IP면 403", async () => {
    const config = createMockConfig({ jwtSecret: SECRET, trustProxy: true });
    const allowList = parseAllowList(["203.0.113.42"]);
    const app = Fastify({ trustProxy: config.trustProxy });

    app.addHook("onRequest", ipFilterHook(allowList));
    app.addHook("onRequest", authHook(config));
    app.get("/api/test", async () => ({ ok: true }));

    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: {
        "x-forwarded-for": "198.51.100.1",
        authorization: `Bearer ${validToken()}`,
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
