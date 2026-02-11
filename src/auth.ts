import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OAConfig } from "./config";

function pathnameFromRequest(req: FastifyRequest): string {
  const u = req.url || req.raw.url || "/";
  try {
    return new URL(u, "http://localhost").pathname;
  } catch {
    // Fallback: strip querystring best-effort.
    const idx = u.indexOf("?");
    return idx === -1 ? u : u.slice(0, idx);
  }
}

export function isSkippablePath(req: FastifyRequest): boolean {
  const path = pathnameFromRequest(req);
  return (
    path === "/healthz" ||
    path === "/livez" ||
    path === "/readyz" ||
    path === "/skill.md" ||
    path === "/skill.md/" ||
    path === "/.well-known/skill.md" ||
    path === "/.well-known/skill.md/"
  );
}

export function authHook(config: OAConfig) {
  return async function onRequest(request: FastifyRequest, reply: FastifyReply) {
    if (isSkippablePath(request)) return;

    const auth = request.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }

    const token = auth.slice("Bearer ".length).trim();
    if (!token) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }

    try {
      const verified = jwt.verify(token, config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: config.jwtIss,
        audience: config.jwtAud,
      });

      if (typeof verified !== "object" || verified == null) {
        reply.code(401).send({ error: "invalid_token" });
        return;
      }

      // jsonwebtoken does not require `exp` unless present; OA requires it.
      if ((verified as jwt.JwtPayload).exp == null) {
        reply.code(401).send({ error: "token_exp_required" });
        return;
      }

      // Attach for future use (not required by OA spec yet).
      (request as any).user = verified;
    } catch (err) {
      request.log.debug({ err }, "jwt verification failed");
      reply.code(401).send({ error: "invalid_token" });
    }
  };
}
