/**
 * Shared streaming SDK mocks for the provider adapter tests.
 *
 * The adapters now consume the provider's STREAM (messages.stream /
 * chat.completions.create({stream}) / generateContentStream) instead of a single
 * completion. These helpers build stream stubs that deliver a given final
 * result, so a test can assert the adapter assembles the SAME shape the
 * non-streamed path used to.
 */

/** Minimal stand-in for the Anthropic SDK's MessageStream. `.finalMessage()`
 *  replays the provided raw events through any `streamEvent` listener (so the
 *  adapter's idle-timer bump fires) and resolves to the assembled message. */
export function anthropicMessageStream(finalMessage: any, events: any[] = [{ type: 'message_delta' }]) {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const obj = {
    on(ev: string, cb: (...a: any[]) => void) {
      (handlers[ev] ||= []).push(cb);
      return obj;
    },
    async finalMessage() {
      for (const e of events) (handlers['streamEvent'] || []).forEach((h) => h(e, finalMessage));
      return finalMessage;
    },
  };
  return obj;
}

/** Build an async-iterable OpenAI completion STREAM from a non-streamed
 *  completion object `{ choices:[{message}], usage }`. Emits a role/content
 *  chunk, one delta per tool call (id+name+arguments), and a final usage chunk
 *  (mirrors stream_options.include_usage). */
export function openAIStreamFromCompletion(completion: any): AsyncIterable<any> {
  const message = completion?.choices?.[0]?.message ?? {};
  const chunks: any[] = [];

  chunks.push({
    choices: [{ index: 0, delta: { role: message.role || 'assistant', content: message.content ?? '' } }],
  });

  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc: any, i: number) => {
      chunks.push({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function?.name, arguments: tc.function?.arguments },
                },
              ],
            },
          },
        ],
      });
    });
  }

  // Final usage-only chunk (empty choices), as OpenAI sends with include_usage.
  chunks.push({ choices: [], usage: completion?.usage });

  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

/** Split an OpenAI tool-call's JSON `arguments` string into N fragment chunks
 *  for the same tool index — proves the adapter reassembles partial_json. */
export function openAIToolCallStream(
  id: string,
  name: string,
  argsJson: string,
  usage?: any,
  pieces = 3
): AsyncIterable<any> {
  const chunks: any[] = [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
  ];
  const size = Math.ceil(argsJson.length / pieces) || 1;
  for (let i = 0; i < argsJson.length; i += size) {
    chunks.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(i, i + size) } }] } }],
    });
  }
  chunks.push({ choices: [], usage });
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

/** Build an async-iterable OpenAI Responses API STREAM that delivers a given
 *  terminal `Response` object. Emits a couple of fine-grained delta events (so
 *  the adapter's idle-timer bump fires more than once) then the terminal
 *  `response.completed` event carrying the full response — the shape
 *  consumeOpenAIResponsesStream folds back. */
export function openAIResponsesStreamFromResponse(response: any): AsyncIterable<any> {
  const events: any[] = [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: '' },
    { type: 'response.completed', response },
  ];
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** Stand-in for GenerateContentStreamResult: the per-chunk stream plus the
 *  aggregated `response` promise the adapter awaits. `response` is the inner
 *  GenerateContentResponse (candidates + usageMetadata). The 2nd arg is either a
 *  count of placeholder chunks, or an explicit array of chunk objects (each a
 *  partial GenerateContentResponse with candidates[].content.parts) — use the
 *  array form to exercise raw-part collection (e.g. thoughtSignature). */
export function googleStreamResult(response: any, streamChunksOrCount: any[] | number = 1) {
  const chunks = Array.isArray(streamChunksOrCount)
    ? streamChunksOrCount
    : Array.from({ length: streamChunksOrCount }, () => ({ text: () => '' }));
  return {
    stream: (async function* () {
      for (const c of chunks) yield c;
    })(),
    response: Promise.resolve(response),
  };
}
