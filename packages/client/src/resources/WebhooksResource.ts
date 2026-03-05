import type { HttpClient } from '../HttpClient.js';
import type { WebhookConfig } from '../types.js';

export class WebhooksResource {
  constructor(private http: HttpClient) {}

  async get(): Promise<WebhookConfig> {
    const r = await this.http.get<any>('/account/webhook');
    return r.webhook;
  }

  async update(body: WebhookConfig): Promise<WebhookConfig> {
    const r = await this.http.put<any>('/account/webhook', body);
    return r.webhook;
  }

  async delete(): Promise<void> {
    await this.http.delete('/account/webhook');
  }

  async test(): Promise<{ sent: boolean }> {
    const r = await this.http.post<any>('/account/webhook/test');
    return r;
  }

  async revealSecret(): Promise<{ secret: string }> {
    const r = await this.http.post<any>('/account/webhook/reveal-secret');
    return r;
  }

  async regenerateSecret(): Promise<{ secret: string }> {
    const r = await this.http.post<any>('/account/webhook/regenerate-secret');
    return r;
  }

  async logs(params?: { page?: number; perPage?: number }): Promise<any[]> {
    const r = await this.http.get<any>('/account/webhook/logs', params as any);
    return r.logs;
  }

  async incoming(params?: { page?: number; perPage?: number }): Promise<any[]> {
    const r = await this.http.get<any>('/account/webhook/incoming', params as any);
    return r.events;
  }
}
