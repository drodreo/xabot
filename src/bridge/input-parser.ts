export type ParsedInput =
  | { kind: 'new'; prompt?: string }
  | { kind: 'compact' }
  | { kind: 'cancel' }
  | { kind: 'unknown_command'; command: string }
  | { kind: 'invoke'; text: string };

export function parseInput(text: string): ParsedInput {
  if (text.startsWith('/new')) {
    const prompt = text.slice(4).trim();
    if (prompt) {
      return { kind: 'new', prompt };
    }
    return { kind: 'new' };
  }
  if (text === '/compact') {
    return { kind: 'compact' };
  }
  if (text === '/cancel') {
    return { kind: 'cancel' };
  }
  if (text.startsWith('/')) {
    return { kind: 'unknown_command', command: text };
  }
  return { kind: 'invoke', text };
}
