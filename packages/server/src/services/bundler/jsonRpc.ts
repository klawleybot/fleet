interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: JsonRpcError;
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

let requestId = 0;

export async function rpcCall<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  requestId += 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`RPC ${method} failed HTTP ${res.status}`);
    }

    const payload = (await res.json()) as JsonRpcResponse<T>;
    if ("error" in payload) {
      const code = payload.error?.code;
      const message = payload.error?.message ?? "Unknown JSON-RPC error";
      throw new Error(`RPC ${method} failed (${code}): ${message}`);
    }

    return payload.result;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`RPC ${method} timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
