import type { EmbeddingAdapter } from './embedding.js';
import { EMBEDDING_DIMENSION } from './constants.js';
export const fakeModel = 'fake-project-embedding@v1';
export function fakeVector(text: string) {
  const vector = Array<number>(EMBEDDING_DIMENSION).fill(0);
  vector[/market|architecture|server|historical|split-adjusted|data/i.test(text) ? 0 : 1] = 1; return vector;
}
export const fakeEmbeddings: EmbeddingAdapter = {
  ready: async () => ({ model: fakeModel, dimension: EMBEDDING_DIMENSION }),
  embed: async text => ({ vector: fakeVector(text), model: fakeModel }),
};
