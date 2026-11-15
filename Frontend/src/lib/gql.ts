export class BackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

type GraphQLResponse<T> = {
  data?: T | null;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
};

export const API_BASE = import.meta.env.VITE_DREAMEDIA_API_BASE ?? "";

/**
 * The frontend talks to ONE endpoint: the backend supergraph at /graphql.
 * Everything else (auth, feed, management, todo) is a field or mutation on
 * that schema.
 */
export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/graphql`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
  } catch {
    throw new BackendError(
      "Could not reach the DreaMedia backend. Start the backend and PostgreSQL, then retry.",
    );
  }

  let payload: GraphQLResponse<T>;
  try {
    payload = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new BackendError(`Backend returned an unreadable response (${response.status}).`);
  }

  if (payload.errors?.length) {
    const first = payload.errors[0].message;
    const unauthenticated = /not authenticated|session expired/i.test(first);
    throw new BackendError(first, unauthenticated ? 401 : response.status);
  }
  if (!response.ok || payload.data == null) {
    throw new BackendError(`Backend request failed (${response.status}).`);
  }
  return payload.data;
}

export function isAuthError(error: unknown): boolean {
  return error instanceof BackendError && error.status === 401;
}
