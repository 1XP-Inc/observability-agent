import type { ReadableStream } from "node:stream/web";

export const MAX_METRICS_BODY_BYTES = 10 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  readonly bytesRead: number;
  readonly limitBytes: number;

  constructor(bytesRead: number, limitBytes: number) {
    super(`response_too_large (${bytesRead} bytes)`);
    this.name = "ResponseTooLargeError";
    this.bytesRead = bytesRead;
    this.limitBytes = limitBytes;
  }
}

type TextResponse = {
  body: ReadableStream<Uint8Array> | null;
};

export async function readResponseTextWithLimit(
  response: TextResponse,
  maxBytes: number = MAX_METRICS_BODY_BYTES,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(bytesRead, maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  const tail = decoder.decode();
  if (tail) chunks.push(tail);
  return chunks.join("");
}
