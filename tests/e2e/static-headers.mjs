// Minimal _headers reader for this repository's path blocks. Matching blocks
// apply in file order, so a later path-specific value overrides the global one.
export function parseHeaders(text) {
  const rules = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      if (!pattern.startsWith('/')) throw new Error(`Unsupported _headers path: ${pattern}`);
      const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      current = { matches: new RegExp(`^${expression}$`), headers: {} };
      rules.push(current);
    } else {
      const separator = line.indexOf(':');
      if (!current || separator < 1) throw new Error('Header must belong to a path block');
      const name = line.slice(0, separator).trim().toLowerCase();
      current.headers[name] = line.slice(separator + 1).trim();
    }
  }
  return rules;
}

export function headersForPath(rules, pathname) {
  return Object.assign({}, ...rules.filter(rule => rule.matches.test(pathname)).map(rule => rule.headers));
}
