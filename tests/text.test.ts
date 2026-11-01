import { describe, expect, it } from 'vitest';
import { countWords, estimateTokens, matchParts, splitParagraphs } from '../src/lib/text';

const wordList = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');

describe('countWords', () => {
  it.each([19, 20, 199, 200])('counts exactly %i words at the selection and page boundaries', (count) => {
    expect(countWords(wordList(count))).toBe(count);
  });

  it('ignores punctuation and extra whitespace', () => {
    expect(countWords('  Hello,   world!  -- ok.\n')).toBe(3);
  });

  it('returns 0 for text with no words', () => {
    expect(countWords(' ... \n')).toBe(0);
  });

  it.each([
    ['Japanese', '吾輩は猫である。名前はまだ無い。'],
    ['Chinese', '今天天气很好,我们一起去公园散步。'],
    ['Thai', 'วันนี้อากาศดีมากเราไปเดินเล่นกัน'],
  ])('finds several words in %s, which has no spaces', (_language, sentence) => {
    expect(countWords(sentence)).toBeGreaterThan(3);
  });
});

describe('estimateTokens', () => {
  it.each([
    ['', 0],
    ['abcde', 2],
    ['abcdef', 3],
  ])('uses 2.5 characters per token, rounded up, for %j', (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });
});

describe('splitParagraphs', () => {
  const allWords = (parts: string[]) => parts.join(' ').split(/\s+/);

  it('keeps short text as one part', () => {
    expect(splitParagraphs('One.\n\nTwo.', 100)).toEqual(['One.\n\nTwo.']);
  });

  it('returns no parts for blank text', () => {
    expect(splitParagraphs(' \n\n \n', 100)).toEqual([]);
  });

  it('breaks between paragraphs when the next one does not fit', () => {
    const first = 'a'.repeat(20);
    const second = 'b'.repeat(20);
    expect(splitParagraphs(`${first}\n\n${second}`, 10)).toEqual([first, second]);
  });

  it('treats blank lines with spaces as paragraph breaks', () => {
    const first = 'a'.repeat(20);
    const second = 'b'.repeat(20);
    expect(splitParagraphs(`${first}\n  \n${second}`, 10)).toEqual([first, second]);
  });

  it('cuts an oversized paragraph at whitespace', () => {
    const paragraph = wordList(100);
    const parts = splitParagraphs(paragraph, 10);
    expect(parts.length).toBeGreaterThan(1);
    expect(allWords(parts)).toEqual(paragraph.split(' '));
  });

  it('cuts text with no spaces at the size limit without losing characters', () => {
    const text = '猫'.repeat(95);
    const parts = splitParagraphs(text, 10);
    expect(parts.every((part) => part.length <= 25)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('never splits an emoji in two', () => {
    const text = 'a' + '😀'.repeat(30);
    const parts = splitParagraphs(text, 4);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => part.isWellFormed())).toBe(true);
  });

  it('drops no word and exceeds no limit on mixed content', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => wordList((i * 7) % 60 + 1));
    const text = paragraphs.join('\n\n');
    const parts = splitParagraphs(text, 40);
    expect(parts.every((part) => estimateTokens(part) <= 40)).toBe(true);
    expect(allWords(parts)).toEqual(text.split(/\s+/));
  });
});

describe('matchParts', () => {
  const parts = ['The cat sat on a mat.', 'Dogs chase the cat and the ball.', 'Rain fell all night.'];

  it('returns the parts that share the most question words first', () => {
    expect(matchParts(parts, 'Do dogs chase a cat?', 100)).toEqual([parts[1], parts[0]]);
  });

  it('ignores case', () => {
    expect(matchParts(parts, 'RAIN', 100)).toEqual([parts[2]]);
  });

  it('ranks real keywords above common words, so the part with the answer is kept', () => {
    const mayor =
      'What the mayor said is that the budget of the city is the largest of the decade, and what follows is the list of the projects.';
    const magma = 'Magma cools slowly underground. Its boiling point depends on silica content.';
    const question = 'What is the boiling point of magma?';
    const limit = estimateTokens(mayor);
    expect(matchParts([mayor, magma], question, limit)).toEqual([magma]);
    expect(matchParts([magma, mayor], question, limit)).toEqual([magma]);
  });

  it('does not send a part that shares only common words with the question', () => {
    const city = 'The city of the river is the home of the mayor.';
    expect(matchParts(['Lava flows at 1200 degrees.', city], 'What is the temperature of lava?', 100)).toEqual([
      'Lava flows at 1200 degrees.',
    ]);
    expect(matchParts([city], 'What is the capital of France?', 100)).toEqual([]);
  });

  it('uses every word when the question has only common words', () => {
    const answer = 'They did what they could.';
    expect(matchParts([answer, 'Rain fell.'], 'What did they do?', 100)).toEqual([answer]);
  });

  it.each(["What's magma?", 'What’s magma?'])('treats a contraction as its common word: %s', (question) => {
    const city = "What's next for the city council is unclear.";
    const magma = 'Magma is molten rock.';
    expect(matchParts([city, magma], question, estimateTokens(magma))).toEqual([magma]);
    expect(matchParts([city], "What's the capital of France?", 100)).toEqual([]);
  });

  it('matches a possessive with its plain word', () => {
    expect(matchParts(['France has many rivers.'], "France's rivers", 100)).toEqual(['France has many rivers.']);
    expect(matchParts(["France's rivers are long."], 'france', 100)).toEqual(["France's rivers are long."]);
  });

  it('returns nothing when no question word appears', () => {
    expect(matchParts(parts, 'quantum physics', 100)).toEqual([]);
  });

  it('returns nothing for a question with no words', () => {
    expect(matchParts(parts, '???', 100)).toEqual([]);
  });

  it('does not match on part of a word', () => {
    expect(matchParts(['Concatenate these.'], 'cat', 100)).toEqual([]);
  });

  it('counts a repeated question word once', () => {
    expect(matchParts(['cat cat', 'cat dog'], 'cat cat dog', 100)).toEqual(['cat dog', 'cat cat']);
  });

  it('stops at the token limit and skips a part that does not fit for one that does', () => {
    const big = `cat dog ${'x'.repeat(100)}`;
    const small = 'cat only';
    const other = 'cat again and again and again and again';
    expect(matchParts([big, small, other], 'cat dog', estimateTokens(small))).toEqual([small]);
  });

  it('matches words in a language with no spaces', () => {
    const japanese = ['猫が好きです。', '雨が降っています。'];
    expect(matchParts(japanese, '猫について', 100)).toEqual([japanese[0]]);
  });
});
