const CHARS_PER_TOKEN = 2.5;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

function words(text: string): string[] {
  return Array.from(wordSegmenter.segment(text))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

export function countWords(text: string): number {
  return words(text).length;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function cutToFit(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    const space = rest.slice(0, maxChars + 1).search(/\s\S*$/);
    const endsInsideEmoji = /[\uD800-\uDBFF]/.test(rest.charAt(maxChars - 1));
    const cut = space > 0 ? space : endsInsideEmoji ? maxChars - 1 : maxChars;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return rest ? [...pieces, rest] : pieces;
}

export function splitParagraphs(text: string, maxTokens: number): string[] {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const piece of cutToFit(paragraph.trim(), maxChars)) {
      const joined = current ? `${current}\n\n${piece}` : piece;
      if (joined.length > maxChars) {
        parts.push(current);
        current = piece;
      } else {
        current = joined;
      }
    }
  }
  return current ? [...parts, current] : parts;
}

// English only, so other languages rank common words as keywords. Upgrade path: a list per language.
const COMMON_WORDS = new Set(
  `a about am an and are as at be been but by can could did do does for from had has have he her his how i
  if in into is it its me my of on or our she should so than that the their them there these they this to
  us was we were what when where which who why will with would you your`.split(/\s+/),
);

// The segmenter keeps "What's" and "France's" as one word.
function matchWords(text: string): string[] {
  return words(text.toLowerCase()).map((word) => word.replace(/['’]s$/, ''));
}

/** Best match first. Empty when no part shares a keyword with the question. */
export function matchParts(parts: string[], question: string, maxTokens: number): string[] {
  const allWords = matchWords(question);
  const keywords = allWords.filter((word) => !COMMON_WORDS.has(word));
  const questionWords = new Set(keywords.length > 0 ? keywords : allWords);
  const matches = parts
    .map((part) => {
      const partWords = new Set(matchWords(part));
      return { part, score: [...questionWords].filter((word) => partWords.has(word)).length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const selected: string[] = [];
  let tokens = 0;
  for (const { part } of matches) {
    const partTokens = estimateTokens(part);
    if (tokens + partTokens <= maxTokens) {
      selected.push(part);
      tokens += partTokens;
    }
  }
  return selected;
}
