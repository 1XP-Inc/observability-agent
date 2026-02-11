import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isSkippablePath } from "./auth";

export function parseAllowList(entries: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const entry of entries) {
    if (entry.includes("/")) {
      const [addr, prefix] = entry.split("/");
      const type = addr.includes(":") ? "ipv6" : "ipv4";
      list.addSubnet(addr, parseInt(prefix, 10), type);
    } else {
      const type = entry.includes(":") ? "ipv6" : "ipv4";
      list.addAddress(entry, type);
    }
  }
  return list;
}

export function ipFilterHook(allowList: net.BlockList) {
  return async function onRequest(req: FastifyRequest, reply: FastifyReply) {
    if (isSkippablePath(req)) return;
    if (!allowList.check(req.ip)) {
      reply.code(403).send({ error: "ip_not_allowed" });
    }
  };
}
