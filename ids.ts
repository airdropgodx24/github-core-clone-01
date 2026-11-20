// Relay-style global ids for GraphQL node(id:) and REST node_id fields: opaque base64
// strings wrapping "<Kind>:<numeric id>". They are stable across reads (a pure function
// of the numeric id), never equal to the plain numeric id, and decodable by the forge.

export type GlobalKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User' | 'Label';

export function encodeGlobalId(kind: GlobalKind, numericId: number): string {
  return Buffer.from(`${kind}:${numericId}`, 'utf8').toString('base64');
}

export function decodeGlobalId(value: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    const id = Number.parseInt(text.slice(at + 1), 10);
    if (!Number.isSafeInteger(id)) return null;
    return { kind: text.slice(0, at), id };
  } catch {
    return null;
  }
}

/** An ISO timestamp for a creation-order stamp, on the same logical clock as the store. */
export function isoFromSeq(seq: number): string {
  return new Date((1735689600 + seq) * 1000).toISOString();
}
