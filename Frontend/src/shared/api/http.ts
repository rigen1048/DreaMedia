export class BackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

type ErrorPayload = {
  detail?: unknown;
  error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${import.meta.env.VITE_DREAMEDIA_API_BASE ?? ""}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    throw new BackendError(
      "Could not reach the DreaMedia backend. Start the backend and PostgreSQL, then retry.",
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("json")
    ? await response.json()
    : await response.text();

  if (response.status === 401) {
    throw new BackendError("Your session has expired. Sign in again.", 401);
  }
  if (!response.ok) {
    const detail =
      isRecord(payload) && "detail" in payload
        ? String((payload as ErrorPayload).detail)
        : `Backend request failed (${response.status}).`;
    throw new BackendError(detail, response.status);
  }
  if (isRecord(payload) && "ok" in payload && payload.ok === false) {
    throw new BackendError(
      String((payload as ErrorPayload).error ?? "The backend rejected this change."),
    );
  }
  return payload as T;
}

export function post(body?: unknown): RequestInit {
  return {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
