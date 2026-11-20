import type { InvokeResult } from '../types.js';

/** A Chat Completions choice's stop reason and refusal, verbatim (InvokeResult.stopReason / .refusal). */
export function chatStopFields(choice: any): Pick<InvokeResult, 'stopReason' | 'refusal'> {
  const refusal = choice?.message?.refusal;
  return {
    ...(typeof choice?.finish_reason === 'string' ? { stopReason: choice.finish_reason } : {}),
    ...(typeof refusal === 'string' && refusal ? { refusal } : {}),
  };
}

/** A Responses object's incomplete reason and refusal parts, verbatim (InvokeResult.stopReason / .refusal). */
export function responsesStopFields(response: any): Pick<InvokeResult, 'stopReason' | 'refusal'> {
  const reason = response?.incomplete_details?.reason;
  const refusal = (response?.output ?? [])
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part?.type === 'refusal' && typeof part.refusal === 'string')
    .map((part: any) => part.refusal)
    .join('');
  return {
    ...(typeof reason === 'string' ? { stopReason: reason } : {}),
    ...(refusal ? { refusal } : {}),
  };
}
