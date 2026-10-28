export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

// A change to a closed month is refused wherever it was made; the app says why.
let onMonthClosed: () => void = () => {};
export function setMonthClosedHandler(fn: () => void) {
  onMonthClosed = fn;
}

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const headers: Record<string, string> = { "X-Budget-App": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (raw) headers["Content-Type"] = "application/octet-stream";
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.error === "not_logged_in") onUnauthorized();
    if (res.status === 409 && data.error === "month_closed") onMonthClosed();
    throw new ApiError(res.status, data.detail ?? data.error ?? "error");
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: (path: string) => request<{ ok: boolean }>("DELETE", path),
  upload: <T>(path: string, file: Blob) => request<T>("POST", path, undefined, file),
};
