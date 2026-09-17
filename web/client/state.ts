/**
 * 画面の状態。サーバーから来たイベントを畳み込むだけの純関数にしておく。
 *
 * SSE は取りこぼしと遅れが起きる。世代とセッションが合わないイベントは捨てる。
 * これを怠ると、モデルを変えた後に古い訳が遅れて届いて表示が巻き戻る。
 */

import type { TranslationState } from '../shared/document';
import type { ServerEvent, Snapshot } from '../shared/protocol';

export function reduceEvent(state: Snapshot, event: ServerEvent): Snapshot {
  switch (event.type) {
    case 'snapshot':
      // snapshot は丸ごと置き換える。世代が上がっていても従う。
      return event.value.sessionId === state.sessionId ? event.value : state;

    case 'block': {
      if (event.sessionId !== state.sessionId) return state;
      if (event.generation !== state.generation) return state;
      const blocks = state.blocks.map((block) =>
        block.id === event.value.id ? event.value : block,
      );
      const known = state.blocks.some((block) => block.id === event.value.id);
      return { ...state, blocks: known ? blocks : [...state.blocks, event.value] };
    }

    case 'error': {
      if (event.sessionId !== state.sessionId) return state;
      if (event.generation !== state.generation) return state;
      return { ...state, error: { code: event.code, message: event.message } };
    }

    default:
      return state;
  }
}

/**
 * PATCH の応答を取り込む。
 *
 * 応答の中身はサーバーが「要求を受けた時点」の姿で、往復の間に届いた訳は入って
 * いない。丸ごと置き換えると、その間に来た block イベントを捨てて、いつまでも
 * 「翻訳中」のまま止まって見える。世代が同じならページ・休止・モデルだけ取り、
 * ブロックの状態は手元のものを残す。
 *
 * 世代が変わったときは、サーバー側で全部やり直しているので丸ごと従う。
 */
export function applySessionResponse(current: Snapshot, incoming: Snapshot): Snapshot {
  if (incoming.sessionId !== current.sessionId) return current;
  if (incoming.generation !== current.generation) return incoming;
  const merged: Snapshot = {
    ...current,
    page: incoming.page,
    paused: incoming.paused,
    model: incoming.model,
  };
  if (incoming.error) merged.error = incoming.error;
  else delete merged.error;
  return merged;
}

export function blockState(state: Snapshot, id: string): TranslationState | undefined {
  return state.blocks.find((block) => block.id === id);
}

export interface Counts {
  total: number;
  translated: number;
  failed: number;
  pending: number;
}

export function countStates(state: Snapshot): Counts {
  let translated = 0;
  let failed = 0;
  let pending = 0;
  for (const block of state.blocks) {
    if (block.status === 'translated') translated += 1;
    else if (block.status === 'error') failed += 1;
    else if (block.status === 'queued' || block.status === 'translating') pending += 1;
  }
  return { total: state.blocks.length, translated, failed, pending };
}
