const SENTENCES = [
  'Photosynthesis is a biological process used by plants, algae, and some bacteria to turn light energy into chemical energy.',
  'That energy is stored in sugars built from carbon dioxide and water, and oxygen is released as a by-product.',
  'Most photosynthesis happens in chloroplasts, where the pigment chlorophyll absorbs red and blue light.',
  'The light reactions split water molecules, release oxygen, and produce the carrier molecules ATP and NADPH.',
  'The Calvin cycle then uses that stored energy to fix carbon dioxide into sugars the plant uses to grow.',
  'When light is limited, the light reactions slow down and the Calvin cycle runs short of ATP and NADPH.',
  'Temperature and carbon dioxide levels also set upper bounds on the overall rate of the whole process.',
  'Crop yields depend directly on how efficiently plants carry out this process, so it is a focus of research.',
];

/** The article text, about 290 words, so it is over the minimum a summary needs. */
export const ARTICLE_PARAGRAPHS = [0, 2, 4, 6, 1, 3].map((start) =>
  Array.from({ length: 3 }, (_, i) => SENTENCES[(start + i) % SENTENCES.length]).join(' '),
);

const NAV_TEXT = 'Home Archive Subscribe Contact';

export function articlePage({ title = 'Photosynthesis', paragraphs = ARTICLE_PARAGRAPHS, extra = '' } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>
<nav>${NAV_TEXT}</nav>
<article><h1>${title}</h1>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n')}${extra}</article>
</body></html>`;
}

export { NAV_TEXT };

export const shortPage = () => articlePage({ title: 'Short', paragraphs: ['Only a few words live on this page, far too few to summarize.'] });

/** Over the default model's input limit of 1,000,000 tokens, at 2.5 characters per token. */
export function longPage(): string {
  const paragraph = ARTICLE_PARAGRAPHS.join(' ');
  const paragraphs = Array.from({ length: Math.ceil(2_600_000 / paragraph.length) }, () => paragraph);
  return articlePage({ title: 'Long', paragraphs });
}
