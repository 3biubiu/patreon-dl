/**
 * The prompt sent to Gemini, in two halves.
 *
 * The half in `SYSTEM_TEMPLATE` fixes the output contract - one translation
 * per index, no merging, no splitting - and is not editable. An administrator
 * who could rewrite it could break the numbering the timings depend on, and
 * the failure would look like a translation bug rather than a settings one.
 *
 * The half an administrator does edit is preferences: tone, terminology, what
 * to leave in the original. It is dropped into a block of its own, so a prompt
 * that says something odd degrades the wording rather than the structure.
 */


/** What the editable half starts as, and what "Reset" puts back. */
export const DEFAULT_PROMPT = [
  '- Keep the speaker\'s register: conversational speech stays conversational, and a lecture stays a lecture.',
  '- Leave product names, brand names and technical terms in the original when there is no settled Chinese equivalent.',
  '- Prefer short lines. A subtitle is read in a couple of seconds, not studied.',
  '- Translate what was said. Do not explain it, annotate it, or add anything that is not there.'
].join('\n');

const SYSTEM_TEMPLATE = [
  'You are a professional subtitle translator. You are given the lines of an SRT',
  'subtitle file as JSON, each with the index it has in the file, and you translate',
  'them into Simplified Chinese.',
  '',
  '<rules>',
  '- Translate every line you are given and return exactly one translation per index.',
  '- Keep the numbering one to one. Never merge, split, reorder or drop a line: the',
  '  timings belong to the original lines and cannot move with the text.',
  '- A line is often half a sentence. Read it as part of the sentence around it, but',
  '  keep the translation inside its own line.',
  '- Do not add an ellipsis to a line that continues into the next one.',
  '- Return the translation only: no notes, no pinyin, no original text.',
  '- A line that is already Simplified Chinese comes back unchanged.',
  '</rules>',
  '',
  '<preferences>',
  '${prompt}',
  '</preferences>',
  '',
  '<output_format>',
  'A JSON array of {"i": <index>, "t": "<translation>"} objects, one for every line',
  'you were given, in the order you were given them.',
  '</output_format>'
].join('\n');

/** The whole system instruction, with the editable half filled in. */
export function buildSystemPrompt(prompt: string | null | undefined) {
  const preferences = (prompt || '').trim() || DEFAULT_PROMPT;
  return SYSTEM_TEMPLATE.replace('${prompt}', preferences);
}
