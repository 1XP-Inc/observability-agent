import { vi } from "vitest";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { authHook } from "../src/auth";
import { createMockConfig } from "./helpers";

const SECRET = "test-secret-key-for-testing";

function buildApp(configOverrides?: Record<string, any>) {
  const config = createMockConfig({ jwtSecret: SECRET, ...configOverrides });
  const app = Fastify();

  // authHook 을 onRequest 훅으로 등록
  app.addHook("onRequest", authHook(config));

  // 인증이 필요한 기본 라우트
  app.get("/api/test", async (request) => {
    return { ok: true, user: (request as any).user };
  });

  // 스킵 가능한 경로들
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/livez", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ok" }));
  app.get("/skill.md", async () => "# Skill");
  app.get("/skill.md/", async () => "# Skill");
  app.get("/.well-known/skill.md", async () => "# Skill");
  app.get("/.well-known/skill.md/", async () => "# Skill");

  return app;
}

function validToken(payload?: Record<string, any>, secret?: string) {
  return jwt.sign(
    { sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600, ...payload },
    secret ?? SECRET,
    { algorithm: "HS256" },
  );
}

afterEach(async () => {
  // Fastify 인스턴스 정리는 각 테스트에서 처리
});

describe("authHook", () => {
  // --- 스킵 가능한 경로 ---
  describe("인증 스킵 경로", () => {
    const skipPaths = [
      "/healthz",
      "/livez",
      "/readyz",
      "/skill.md",
      "/skill.md/",
      "/.well-known/skill.md",
      "/.well-known/skill.md/",
    ];

    for (const p of skipPaths) {
      it(`${p} 는 토큰 없이도 200 을 반환한다`, async () => {
        const app = buildApp();
        const res = await app.inject({ method: "GET", url: p });
        expect(res.statusCode).toBe(200);
        await app.close();
      });
    }
  });

  // --- Authorization 헤더 누락 ---
  it("Authorization 헤더가 없으면 401 missing_token", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/test" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_token");
    await app.close();
  });

  // --- Bearer 접두사 없는 경우 ---
  it("Bearer 접두사가 없으면 401 missing_token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: "Token abc" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_token");
    await app.close();
  });

  // --- Bearer 뒤에 빈 토큰 ---
  it("Bearer 뒤에 토큰이 비어있으면 401 missing_token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_token");
    await app.close();
  });

  it("Bearer 뒤에 공백만 있으면 401 missing_token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: "Bearer    " },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("missing_token");
    await app.close();
  });

  // --- 유효하지 않은 JWT ---
  it("유효하지 않은 JWT 이면 401 invalid_token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    await app.close();
  });

  // --- 잘못된 시크릿으로 서명된 JWT ---
  it("다른 시크릿으로 서명된 JWT 이면 401 invalid_token", async () => {
    const app = buildApp();
    const token = validToken({}, "wrong-secret");
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    await app.close();
  });

  // --- 잘못된 알고리즘 ---
  it("HS384 로 서명된 JWT 이면 401 invalid_token", async () => {
    const app = buildApp();
    const token = jwt.sign(
      { sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
      { algorithm: "HS384" },
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    await app.close();
  });

  // --- exp 클레임 누락 ---
  it("exp 클레임이 없으면 401 token_exp_required", async () => {
    const app = buildApp();
    // exp 없이 서명 (jsonwebtoken 은 exp 필수가 아님)
    const token = jwt.sign({ sub: "user-1" }, SECRET, { algorithm: "HS256" });
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("token_exp_required");
    await app.close();
  });

  // --- 유효한 JWT ---
  it("유효한 JWT 이면 200 을 반환하고 user 를 request 에 첨부한다", async () => {
    const app = buildApp();
    const token = validToken({ sub: "user-42" });
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.user.sub).toBe("user-42");
    await app.close();
  });

  // --- 만료된 JWT ---
  it("만료된 JWT 이면 401 invalid_token", async () => {
    const app = buildApp();
    const token = jwt.sign(
      { sub: "user-1", exp: Math.floor(Date.now() / 1000) - 100 },
      SECRET,
      { algorithm: "HS256" },
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
    await app.close();
  });

  // --- jwtIss 검증 ---
  describe("issuer 검증", () => {
    it("jwtIss 가 설정되어 있고 일치하면 통과", async () => {
      const app = buildApp({ jwtIss: "my-issuer" });
      const token = jwt.sign(
        { sub: "u", exp: Math.floor(Date.now() / 1000) + 3600, iss: "my-issuer" },
        SECRET,
        { algorithm: "HS256" },
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/test",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("jwtIss 가 설정되어 있고 불일치하면 401", async () => {
      const app = buildApp({ jwtIss: "my-issuer" });
      const token = jwt.sign(
        { sub: "u", exp: Math.floor(Date.now() / 1000) + 3600, iss: "wrong-issuer" },
        SECRET,
        { algorithm: "HS256" },
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/test",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_token");
      await app.close();
    });
  });

  // --- jwtAud 검증 ---
  describe("audience 검증", () => {
    it("jwtAud 가 설정되어 있고 일치하면 통과", async () => {
      const app = buildApp({ jwtAud: "my-audience" });
      const token = jwt.sign(
        { sub: "u", exp: Math.floor(Date.now() / 1000) + 3600, aud: "my-audience" },
        SECRET,
        { algorithm: "HS256" },
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/test",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("jwtAud 가 설정되어 있고 불일치하면 401", async () => {
      const app = buildApp({ jwtAud: "my-audience" });
      const token = jwt.sign(
        { sub: "u", exp: Math.floor(Date.now() / 1000) + 3600, aud: "wrong-audience" },
        SECRET,
        { algorithm: "HS256" },
      );
      const res = await app.inject({
        method: "GET",
        url: "/api/test",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_token");
      await app.close();
    });
  });

  // --- 쿼리 스트링이 있는 URL 처리 ---
  it("URL 에 쿼리 스트링이 있어도 경로를 올바르게 추출한다", async () => {
    const app = buildApp();
    // /healthz?check=true 로 요청 → 스킵 경로
    const res = await app.inject({
      method: "GET",
      url: "/healthz?check=true",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("인증이 필요한 경로에 쿼리스트링이 있어도 인증이 필요하다", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/test?foo=bar",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // --- pathnameFromRequest: req.url 이 falsy 일 때 fallback 분기 ---
  describe("pathnameFromRequest URL fallback 분기", () => {
    it("req.url 이 falsy 이고 req.raw.url 이 있으면 raw.url 을 사용한다", async () => {
      const config = createMockConfig({ jwtSecret: SECRET });
      const app = Fastify();

      // authHook 보다 먼저 실행되는 훅에서 req.url 을 undefined 로 설정
      // Fastify 내부에서 req.url 은 req.raw.url 과 별도로 존재
      app.addHook("onRequest", async (request) => {
        // req.raw.url 은 원본 "/healthz" 를 유지하므로 fallback 으로 사용됨
        Object.defineProperty(request, "url", { value: undefined, writable: true });
      });
      app.addHook("onRequest", authHook(config));
      app.get("/healthz", async () => ({ status: "ok" }));

      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("req.url 과 req.raw.url 모두 falsy 이면 '/' 로 fallback 한다", async () => {
      const config = createMockConfig({ jwtSecret: SECRET });
      const app = Fastify();

      app.addHook("onRequest", async (request) => {
        Object.defineProperty(request, "url", { value: undefined, writable: true });
        Object.defineProperty(request.raw, "url", { value: undefined, writable: true });
      });
      app.addHook("onRequest", authHook(config));
      // "/" 는 스킵 대상이 아니므로 401 이 되어야 한다
      app.get("/", async () => ({ status: "ok" }));

      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("missing_token");
      await app.close();
    });
  });

  // --- pathnameFromRequest catch 브랜치 (URL 파싱 실패 fallback) ---
  describe("pathnameFromRequest catch 브랜치", () => {
    it("new URL() 이 실패하고 쿼리스트링이 있으면 '?' 앞을 반환한다", async () => {
      const config = createMockConfig({ jwtSecret: SECRET });
      const app = Fastify();
      app.addHook("onRequest", authHook(config));
      app.get("/healthz", async () => ({ status: "ok" }));

      const OriginalURL = globalThis.URL;
      globalThis.URL = class BrokenURL {
        constructor() {
          throw new Error("broken URL constructor");
        }
      } as any;

      try {
        const res = await app.inject({ method: "GET", url: "/healthz?q=1" });
        expect(res.statusCode).toBe(200);
      } finally {
        globalThis.URL = OriginalURL;
        await app.close();
      }
    });

    it("new URL() 이 실패하고 쿼리스트링이 없으면 url 그대로 반환한다", async () => {
      const config = createMockConfig({ jwtSecret: SECRET });
      const app = Fastify();
      app.addHook("onRequest", authHook(config));
      app.get("/healthz", async () => ({ status: "ok" }));

      const OriginalURL = globalThis.URL;
      globalThis.URL = class BrokenURL {
        constructor() {
          throw new Error("broken URL constructor");
        }
      } as any;

      try {
        const res = await app.inject({ method: "GET", url: "/healthz" });
        expect(res.statusCode).toBe(200);
      } finally {
        globalThis.URL = OriginalURL;
        await app.close();
      }
    });
  });

  // --- jwt.verify 가 문자열(non-object)을 반환하는 경우 ---
  it("jwt.verify 가 객체가 아닌 값을 반환하면 401 invalid_token", async () => {
    const app = buildApp();
    const token = validToken();

    // jwt.verify 를 일시적으로 스파이하여 string 반환하도록 조작
    const verifySpy = vi.spyOn(jwt, "verify").mockReturnValueOnce("string-payload" as any);

    const res = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");

    verifySpy.mockRestore();
    await app.close();
  });
});
