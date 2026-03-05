/**
 * Thin HTTP client for the Agnt REST API.
 * Handles auth token injection, JSON parsing, and error handling.
 */

export class AgntApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorCode?: string
  ) {
    super(message);
    this.name = 'AgntApiError';
  }
}

export class HttpClient {
  private apiUrl: string;
  private getToken: () => Promise<string>;

  constructor(apiUrl: string, getToken: () => Promise<string>) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.getToken = getToken;
  }

  private async request<T>(method: string, path: string, body?: any, params?: Record<string, any>): Promise<T> {
    const token = await this.getToken();

    let url = `${this.apiUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      url += `?${qs.toString()}`;
    }

    const init: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text();
      let message = text;
      let errorCode: string | undefined;
      try {
        const json = JSON.parse(text);
        message = json.error ?? text;
        errorCode = json.error_code;
      } catch { /* use raw text */ }
      throw new AgntApiError(response.status, message, errorCode);
    }

    return response.json() as Promise<T>;
  }

  get<T>(path: string, params?: Record<string, any>): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  post<T>(path: string, body?: any): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: any): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
