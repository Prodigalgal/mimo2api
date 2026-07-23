export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON(requestId?: string): object {
    return {
      error: {
        message: this.message,
        type: this.status >= 500 ? "server_error" : "invalid_request_error",
        code: this.code,
        param: this.param ?? null,
        request_id: requestId,
      },
    };
  }
}

export const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && "statusCode" in error && Number.isInteger((error as Error & { statusCode?: number }).statusCode)) {
    const status = (error as Error & { statusCode: number }).statusCode;
    return new ApiError(status, String((error as Error & { code?: string }).code ?? "request_error").toLowerCase(), error.message);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ApiError(499, "request_cancelled", "request was cancelled");
  }
  return new ApiError(500, "internal_error", error instanceof Error ? error.message : String(error));
};
