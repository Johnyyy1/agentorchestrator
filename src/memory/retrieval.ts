import type { MemoryDto } from '../projects/contracts.js';
import { RETRIEVAL_CANDIDATES, RETRIEVAL_LIMIT } from './constants.js';
export type RankedMemory = MemoryDto & { similarity: number; score: number };
export function memoryScore(similarity: number, importance: number, createdAt: string, now = Date.now()) {
  const ageDays = Math.max(0, (now - Date.parse(createdAt)) / 86400000);
  return 0.90 * Math.max(-1, Math.min(1, similarity)) + 0.07 * (importance / 5) + 0.03 / (1 + ageDays / 30);
}
export function rankMemories(projectId: string, candidates: Array<MemoryDto & { similarity: number }>, limit = RETRIEVAL_LIMIT, now = Date.now()): RankedMemory[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > RETRIEVAL_LIMIT) throw new Error('Invalid retrieval limit.');
  return candidates.filter(m => m.projectId === projectId && Number.isFinite(m.similarity) && m.similarity >= 0.2)
    .slice(0, RETRIEVAL_CANDIDATES).map(m => ({ ...m, score: memoryScore(m.similarity, m.importance, m.createdAt, now) }))
    .sort((a, b) => b.score - a.score || b.similarity - a.similarity || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, limit);
}
