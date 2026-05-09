import type { FastifyRequest } from "fastify";
import { HttpError } from "./http-error";

export type Capability = "pods" | "logs" | "events" | "metrics";

export type Principal = {
  admin: boolean;
  allowedNamespaces: string[];
  allowedServices: string[];
  capabilities: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function hasAuthorizationClaims(user: Record<string, unknown>): boolean {
  return (
    user.admin != null ||
    user.allowedNamespaces != null ||
    user.allowedServices != null ||
    user.capabilities != null
  );
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;

  const parts = pattern.split("*");
  let pos = 0;
  for (const [i, part] of parts.entries()) {
    if (!part) continue;
    const idx = value.indexOf(part, pos);
    if (idx === -1) return false;
    if (i === 0 && idx !== 0) return false;
    pos = idx + part.length;
  }

  const last = parts[parts.length - 1];
  return last === "" || value.endsWith(last);
}

export function principalFromRequest(request: FastifyRequest): Principal {
  const user = (request as any).user;
  if (!isRecord(user)) {
    return { admin: false, allowedNamespaces: [], allowedServices: [], capabilities: [] };
  }

  if (!hasAuthorizationClaims(user)) {
    return { admin: true, allowedNamespaces: [], allowedServices: [], capabilities: [] };
  }

  return {
    admin: user.admin === true,
    allowedNamespaces: stringArray(user.allowedNamespaces),
    allowedServices: stringArray(user.allowedServices),
    capabilities: stringArray(user.capabilities),
  };
}

export function hasCapability(principal: Principal, capability: Capability): boolean {
  return principal.admin || principal.capabilities.includes(capability);
}

export function assertCapabilities(principal: Principal, capabilities: Capability[]): void {
  if (principal.admin) return;
  for (const capability of capabilities) {
    if (!principal.capabilities.includes(capability)) {
      throw new HttpError(403, "forbidden");
    }
  }
}

export function isNamespaceAllowed(principal: Principal, namespace: string): boolean {
  if (principal.admin) return true;
  return principal.allowedNamespaces.some((pattern) => matchesPattern(pattern, namespace));
}

export function assertNamespaceAllowed(principal: Principal, namespace: string): void {
  if (!isNamespaceAllowed(principal, namespace)) {
    throw new HttpError(403, "forbidden");
  }
}

export function assertNamespacesAllowed(principal: Principal, namespaces: string[]): void {
  for (const namespace of namespaces) {
    assertNamespaceAllowed(principal, namespace);
  }
}

export function isServiceAllowed(principal: Principal, serviceName: string): boolean {
  if (principal.admin) return true;
  return principal.allowedServices.some((pattern) => matchesPattern(pattern, serviceName));
}

export function assertServicesAllowed(principal: Principal, serviceNames: string[]): void {
  for (const serviceName of serviceNames) {
    if (!isServiceAllowed(principal, serviceName)) {
      throw new HttpError(403, "forbidden");
    }
  }
}
