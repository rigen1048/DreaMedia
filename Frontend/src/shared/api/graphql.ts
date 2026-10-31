import { BackendError, post, request } from "./http";

type GraphqlError = {
  message: string;
};

type GraphqlResponse<TData> = {
  data?: TData | null;
  errors?: GraphqlError[];
};

export async function graphQLRequest<TData>(
  query: string,
  variables: Record<string, unknown>,
): Promise<TData> {
  const response = await request<GraphqlResponse<TData>>("/graphql", post({ query, variables }));

  if (response.errors?.length) {
    throw new BackendError(response.errors.map((error) => error.message).join("; "));
  }
  if (response.data === undefined || response.data === null) {
    throw new BackendError("The GraphQL backend returned no data.");
  }

  return response.data;
}
