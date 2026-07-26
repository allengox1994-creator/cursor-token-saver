// 多路检索融合：精确字符串、BM25、神经向量各自排名后用 RRF 合并。
// 不把任一路当作绝对真相；来源越多、排名越高，置信度越高。
export function reciprocalRankFuse(groups, { k = 60, topN = 8 } = {}) {
  const merged = new Map();
  for (const [source, hits] of Object.entries(groups)) {
    for (let i = 0; i < (hits || []).length; i++) {
      const hit = hits[i];
      if (!hit?.rel) continue;
      const cur = merged.get(hit.rel) || { rel: hit.rel, score: 0, sources: [], ranges: [] };
      cur.score += 1 / (k + i + 1);
      if (!cur.sources.includes(source)) cur.sources.push(source);
      if (hit.start || hit.line) {
        const start = hit.start || hit.line;
        const end = hit.end || hit.line || start;
        cur.ranges.push({ start, end, source });
      }
      merged.set(hit.rel, cur);
    }
  }
  return [...merged.values()]
    .map((hit) => {
      const priority = { exact: 0, vector: 1, bm25: 2 };
      hit.ranges.sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9) || a.start - b.start);
      hit.range = hit.ranges[0] || null;
      hit.confidence = Math.min(1, hit.sources.length / 3 + hit.score * 8);
      return hit;
    })
    .sort((a, b) => b.score - a.score || b.sources.length - a.sources.length)
    .slice(0, topN);
}

export function retrievalConfidence(hits) {
  if (!hits?.length) return { level: 'none', score: 0, reason: 'no matches' };
  const top = hits[0];
  const second = hits[1];
  const sourceCoverage = top.sources.length / 3;
  const gap = second ? Math.max(0, (top.score - second.score) / Math.max(top.score, 1e-9)) : 1;
  const score = Math.min(1, sourceCoverage * 0.7 + gap * 0.3);
  return {
    level: score >= 0.72 ? 'high' : score >= 0.42 ? 'medium' : 'low',
    score,
    reason: `${top.sources.length}/3 retrieval paths agree; rank gap ${Math.round(gap * 100)}%`
  };
}
