export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const UPLOAD_CHUNK_RETRIES = 3;

export async function readApiResponse<T>(response: Response): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  detail: string;
}> {
  const text = await response.text();
  if (!text) {
    return {
      ok: response.ok,
      status: response.status,
      data: null,
      detail: response.ok
        ? ''
        : `Request failed · HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    };
  }

  try {
    const data = JSON.parse(text) as T & { detail?: string };
    return {
      ok: response.ok,
      status: response.status,
      data,
      detail: data?.detail ?? '',
    };
  } catch {
    return {
      ok: response.ok,
      status: response.status,
      data: null,
      detail: response.ok
        ? 'Server returned an invalid response'
        : `Request failed · HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} · ${text.slice(0, 220)}`,
    };
  }
}

export function humanSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
