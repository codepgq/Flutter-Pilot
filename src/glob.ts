/** Translate the shared fnmatch path syntax for runtime rules and catalog previews. */
export function globRegex(pattern: string): string {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === '*') {
      if (pattern[i - 1] !== '*') result += '.*';
    } else if (character === '?') result += '.';
    else if (character === '[') {
      let end = i + 1;
      if (pattern[end] === '!') end++;
      if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') end++;
      if (end >= pattern.length) result += '\\[';
      else {
        let content = pattern.slice(i + 1, end);
        const negate = content.startsWith('!');
        if (negate) content = content.slice(1);
        content = content.replace(/\\/g, '\\\\');
        if (content.startsWith('^') || content.startsWith(']')) content = '\\' + content;
        const characterClass = '[' + (negate ? '^' : '') + content + ']';
        try {
          new RegExp(characterClass);
          result += characterClass;
        } catch {
          result += '(?!)';
        }
        i = end;
      }
    } else result += character.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return result + '$';
}
