/**
 * Turns what someone typed into a search box into an FTS5 MATCH expression.
 *
 * FTS5's query language is not a superset of plain text - it is a syntax, and
 * a good deal of ordinary English is invalid in it. `it's` fails on the
 * apostrophe, `Q&A` on the ampersand, `C++` on the plus signs, `AND` on being
 * a bare operator, an odd number of double quotes on the unterminated string,
 * and `foo-bar` is read as a column filter and complains that there is no
 * column `bar`. All six raise instead of returning nothing, and the handler
 * throws them straight out as a failed request.
 *
 * So every token is wrapped in double quotes, which makes it a literal phrase
 * and takes the whole operator language off the table. The cost is that
 * `OR`, `NEAR` and `-` stop working as operators; that is the right trade for
 * a search box, where people who would type `NEAR/3` are outnumbered by
 * people who type an apostrophe by some orders of magnitude.
 *
 * The last token additionally gets a `*`, so that a query is treated as a
 * prefix of the word being typed - the default tokenizer matches whole tokens
 * only, and without this `camp` does not find "camping".
 *
 * That `*` is withheld when the query does not end in a letter or a digit.
 * The tokenizer drops trailing punctuation, so `C++` would otherwise become
 * the prefix `c*` and match every post with a word starting in C; someone who
 * typed the punctuation typed a whole term, not the start of one.
 */
export function toFTSMatchQuery(raw: string): string | null {
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    // Nothing but whitespace. `MATCH ''` is itself a syntax error, so the
    // caller is told to search for nothing rather than for the empty string.
    return null;
  }
  // A double quote inside a phrase is escaped by doubling it, the same rule
  // SQL string literals use.
  const phrases = words.map((word) => `"${word.replace(/"/g, '""')}"`);
  const lastWord = words[words.length - 1];
  const lastPhrase = phrases[phrases.length - 1];
  return [
    ...phrases.slice(0, -1),
    /[\p{L}\p{N}]$/u.test(lastWord) ? `${lastPhrase}*` : lastPhrase
  ].join(' ');
}
