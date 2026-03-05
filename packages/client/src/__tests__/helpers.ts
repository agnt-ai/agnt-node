import { vi } from 'vitest';
import type { HttpClient } from '../HttpClient.js';

export function makeMockHttp(): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  } as unknown as HttpClient;
}
