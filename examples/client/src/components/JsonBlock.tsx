import * as React from 'react'

/**
 * Pretty-printed JSON with key/value/string/bool/null highlighting.
 *
 * Implemented as a token-walking renderer that emits React elements
 * directly — NO dangerouslySetInnerHTML. The original vanilla-TS demo
 * used a regex + innerHTML approach, but that surface is XSS-prone when
 * the input includes server-returned strings (e.g. challenge.realm,
 * server response body). Even with prior HTML-escaping, dropping the
 * raw-HTML path entirely is defense-in-depth + satisfies React lint.
 *
 * Token types we emit colored spans for: keys, strings, numbers, true,
 * false, null. Whitespace + structural punctuation (`{}`, `[]`, `,`)
 * render uncolored.
 */

interface Token {
  kind: 'key' | 'string' | 'number' | 'bool' | 'null' | 'text'
  value: string
}

function tokenize(json: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < json.length) {
    const c = json[i]!
    if (c === '"') {
      // string literal — scan until closing quote, respecting escapes
      let j = i + 1
      while (j < json.length) {
        if (json[j] === '\\') {
          j += 2
          continue
        }
        if (json[j] === '"') break
        j++
      }
      const lit = json.slice(i, j + 1)
      // peek whitespace, then `:` → it's a key
      let k = j + 1
      while (k < json.length && (json[k] === ' ' || json[k] === '\t')) k++
      if (json[k] === ':') {
        tokens.push({ kind: 'key', value: lit })
      } else {
        tokens.push({ kind: 'string', value: lit })
      }
      i = j + 1
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      // number — scan digits / sign / decimal / exponent
      let j = i
      while (j < json.length && /[\d.eE+-]/.test(json[j]!)) j++
      tokens.push({ kind: 'number', value: json.slice(i, j) })
      i = j
      continue
    }
    if (json.startsWith('true', i)) {
      tokens.push({ kind: 'bool', value: 'true' })
      i += 4
      continue
    }
    if (json.startsWith('false', i)) {
      tokens.push({ kind: 'bool', value: 'false' })
      i += 5
      continue
    }
    if (json.startsWith('null', i)) {
      tokens.push({ kind: 'null', value: 'null' })
      i += 4
      continue
    }
    // Structural / whitespace — coalesce contiguous runs as 'text' so we
    // emit fewer React nodes.
    let j = i
    while (j < json.length && '{}[],:\n\r\t '.includes(json[j]!)) j++
    if (j > i) {
      tokens.push({ kind: 'text', value: json.slice(i, j) })
      i = j
      continue
    }
    // Unknown char — bail out as text-by-one so we don't loop forever.
    tokens.push({ kind: 'text', value: c })
    i++
  }
  return tokens
}

function classFor(kind: Token['kind']): string {
  switch (kind) {
    case 'key':
      return 'json-key'
    case 'string':
      return 'json-string'
    case 'number':
      return 'json-number'
    case 'bool':
      return 'json-bool'
    case 'null':
      return 'json-null'
    default:
      return ''
  }
}

export function JsonBlock({ value }: { value: unknown }): JSX.Element {
  const json = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  const tokens = tokenize(json ?? 'undefined')
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background/70 p-4 font-mono text-xs leading-relaxed">
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          <React.Fragment key={i}>{t.value}</React.Fragment>
        ) : (
          <span key={i} className={classFor(t.kind)}>
            {t.value}
          </span>
        ),
      )}
    </pre>
  )
}
