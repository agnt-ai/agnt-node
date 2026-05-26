/**
 * Tracing Utilities
 *
 * Fire-and-forget trace payloads to the observability API.
 */

import type { TracingConfig, Message, PromptManifestV2 } from './types.js';

export interface TracePayload {
  promptName: string;
  manifest: PromptManifestV2;
  etag: string | null;
  variables: Record<string, any>;
  messages: Message[];
  output: any;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cost: number;
  duration: number;
  model: {
    provider: string;
    name: string;
    metadata: Record<string, any>;
  };
  status: string;
  metadata: Record<string, any>;
  tags: string[];
}

/**
 * Send trace to observability API (fire-and-forget — does not block execution)
 */
export async function sendTrace(
  tracing: TracingConfig,
  payload: TracePayload,
  log: (message: string, ...args: any[]) => void
): Promise<void> {
  if (!tracing?.enabled) return;

  if (!tracing.apiUrl || !tracing.serviceKey) {
    log('[Tracing] Missing required config (apiUrl, serviceKey)');
    return;
  }

  try {
    const url = `${tracing.apiUrl}/traces`;

    fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tracing.serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        log('[Tracing] Trace failed:', text);
      }
    }).catch(error => {
      log('[Tracing] Failed to send trace:', error.message);
    });
  } catch (error: any) {
    log('[Tracing] Error sending trace:', error.message);
  }
}
