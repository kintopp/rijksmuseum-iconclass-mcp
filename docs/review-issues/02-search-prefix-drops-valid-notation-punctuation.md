# `search_prefix` Drops Valid Notation Punctuation

Priority: P2
Area: Iconclass prefix search
Source: `src/api/IconclassDb.ts`

## Summary

`searchPrefix()` rewrites the requested prefix by removing every character except letters, digits, parentheses, and plus signs:

```ts
const clean = prefix.replace(/[^a-zA-Z0-9()+]/g, "");
```

Real Iconclass notations can contain punctuation such as periods, spaces, colons, and hyphens. Stripping those characters changes the notation and causes valid prefixes to return zero results.

## Impact

Users cannot enumerate valid subtrees for punctuation-bearing notations, even though those notations exist and can be resolved directly.

One verified example:

- `resolve("12A27(Deut. 21:22-23)")` succeeds.
- Direct SQL `LIKE '12A27(Deut. 21:22-23)%'` finds 2 rows.
- `searchPrefix("12A27(Deut. 21:22-23)")` returns 0 rows because the prefix is rewritten.

## Affected Code

`src/api/IconclassDb.ts`

```ts
const clean = prefix.replace(/[^a-zA-Z0-9()+]/g, "");
if (!clean) return empty;

const likePattern = `${clean}%`;
```

## Reproduction

After building the project with the local DB available:

```js
const { IconclassDb } = await import("./dist/api/IconclassDb.js");
const db = new IconclassDb();

const notation = "12A27(Deut. 21:22-23)";
console.log(db.resolve([notation], "en").length);
console.log(db.rawDb.prepare(
  "SELECT COUNT(*) n FROM notations WHERE notation LIKE ?"
).get(`${notation}%`).n);
console.log(db.searchPrefix(notation, 10, "en").totalResults);
```

Expected:

```text
1
2
2
```

Current:

```text
1
2
0
```

## Recommended Fix

Do not strip valid notation characters. Instead:

- Trim surrounding whitespace.
- Escape SQL `LIKE` wildcard characters (`%`, `_`) and the escape character itself.
- Use `LIKE ? ESCAPE '\\'` or equivalent.

Example helper shape:

```ts
function escapeLikePrefix(value: string): string {
  return value.trim().replace(/[\\%_]/g, ch => `\\${ch}`);
}
```

Then query with:

```sql
WHERE notation LIKE ? ESCAPE '\'
```

## Acceptance Criteria

- `search_prefix` preserves punctuation that is valid in Iconclass notations.
- Prefixes containing `.`, spaces, `:`, and `-` work when present in the DB.
- User-supplied `%` and `_` are treated as literal characters, not wildcards.
- Existing simple prefixes such as `73D8` and `25F` still work.
- Add a regression test for `12A27(Deut. 21:22-23)`.
