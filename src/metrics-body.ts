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
  text: () => Promise<string>;
};

export async function readResponseTextWithLimit(
  response: TextResponse,
  maxBytes: number = MAX_METRICS_BODY_BYTES,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new ResponseTooLargeError(bytes, maxBytes);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(bytesRead, maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  text += decoder.decode();
  return text;
}
