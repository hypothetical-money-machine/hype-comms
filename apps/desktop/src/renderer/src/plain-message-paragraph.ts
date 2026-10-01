/**
 * Recognize a conservative subset of single-line paragraphs whose Markdown output is
 * exactly their text inside a paragraph. Everything else goes through the full parser.
 * Keep this alphabet narrow: punctuation can introduce Markdown, entities, or GFM links.
 */
export function isPlainMessageParagraph(body: string): boolean {
  return (
    body.length > 0 &&
    !/[^\p{L}\p{N}\p{M} ,;!?'"().-]/u.test(body) &&
    !body.startsWith(" ") &&
    !body.endsWith(" ") &&
    !/^(?:-+(?: |$)|[0-9]{1,9}[.)](?: |$))/u.test(body) &&
    !/www\./iu.test(body)
  );
}
