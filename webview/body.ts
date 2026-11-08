/** Format JSON for inspection without changing numeric literals or duplicate keys. */
export function inspectJson(body: string): { formatted?: string; hint?: string } {
  if (!body.trim()) return {};
  if (body.length > 1024 * 1024) return { hint: '正文较大，已显示原文；可复制后在编辑器中解析' };
  try {
    JSON.parse(body);
  } catch {
    return { hint: '无法解析为 JSON，已显示原文' };
  }
  // JSON.parse validates the grammar only. Re-serializing its result would round
  // large financial IDs/numbers and discard duplicate object keys.
  const tokens = body.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const parts: string[] = [];
  let depth = 0;
  let length = 0;
  const newline = () => '\n' + '  '.repeat(Math.min(depth, 24));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let part = token;
    if (token === '{' || token === '[') {
      depth++;
      if (tokens[i + 1] !== (token === '{' ? '}' : ']')) part += newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (tokens[i - 1] !== (token === '}' ? '{' : '[')) part = newline() + token;
    } else if (token === ',') part += newline();
    else if (token === ':') part += ' ';
    length += part.length;
    if (length > 4 * 1024 * 1024) return { hint: '格式化结果较大，已显示原文' };
    parts.push(part);
  }
  return { formatted: parts.join('') };
}
