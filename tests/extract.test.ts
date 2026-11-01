import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import extract, { type Extraction } from '../src/entrypoints/extract';

const sentence = (topic: string, i: number) =>
  `The ${topic} study number ${i} describes measured results from careful work, and it explains what those results mean for readers.`;
const paragraph = (topic: string, start = 0) =>
  `<p>${Array.from({ length: 6 }, (_, i) => sentence(topic, start + i)).join(' ')}</p>`;

const NAV = '<nav class="site-nav"><ul><li><a href="/">NAVLINK home</a></li><li><a href="/x">NAVLINK about</a></li></ul></nav>';
const AD = '<aside class="ad advert sponsored"><p>ADTEXT buy this product today</p></aside>';
const FOOTER = '<footer class="site-footer"><p>FOOTERTEXT copyright and legal notices</p></footer>';
const COMMENTS =
  '<section id="comments" class="comments"><h2>Comments</h2><div class="comment"><p>COMMENTTEXT I disagree with this and here is why at some length.</p></div></section>';

const PAGES: [string, string][] = [
  [
    'a news article',
    `<html><head><title>News</title></head><body>${NAV}${AD}<main><article><h1>Glaciers</h1>${paragraph('glacier')}${paragraph('glacier', 10)}${paragraph('glacier', 20)}</article></main>${COMMENTS}${FOOTER}</body></html>`,
  ],
  [
    'a blog post in plain divs',
    `<html><head><title>Blog</title></head><body>${NAV}<div class="content"><div class="post"><h1>Glaciers</h1>${paragraph('glacier')}${AD}${paragraph('glacier', 10)}${paragraph('glacier', 20)}</div></div>${COMMENTS}${FOOTER}</body></html>`,
  ],
  [
    'a reference page with sections',
    `<html><head><title>Reference</title></head><body>${NAV}<div id="main"><h1>Glaciers</h1><section><h2>Formation</h2>${paragraph('glacier')}</section><section><h2>Movement</h2>${paragraph('glacier', 10)}</section><section><h2>Retreat</h2>${paragraph('glacier', 20)}</section></div>${FOOTER}</body></html>`,
  ],
];

function loadPage(html: string, contentType = 'text/html') {
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'contentType', { value: contentType });
  vi.stubGlobal('document', document);
  return document;
}

const run = () => extract.main() as unknown as Extraction;

afterEach(() => vi.unstubAllGlobals());

describe('main content', () => {
  it.each(PAGES)('returns the article of %s without navigation, ads, footers, or comments', (_name, html) => {
    loadPage(html);
    const { text } = run();
    expect(text).toContain('glacier study number 0');
    expect(text).toContain('glacier study number 25');
    expect(text).not.toMatch(/NAVLINK|ADTEXT|FOOTERTEXT|COMMENTTEXT/);
  });

  it('leaves the real page untouched', () => {
    const [, html] = PAGES[0]!;
    const document = loadPage(html);
    const before = document.documentElement.outerHTML;
    run();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  const articleWith = (extra: string) =>
    `<html><head><title>T</title></head><body><article><h1>Glaciers</h1>${paragraph('glacier')}${extra}${paragraph('glacier', 10)}${paragraph('glacier', 20)}</article></body></html>`;

  const articleEndingWith = (extra: string) =>
    `<html><head><title>T</title></head><body><article><h1>Glaciers</h1>${paragraph('glacier')}${paragraph('glacier', 10)}${paragraph('glacier', 20)}${extra}</article></body></html>`;

  it.each([
    '<div class="ad">EXTRA buy now</div>',
    '<div class="ads">EXTRA buy now</div>',
    '<div class="advert">EXTRA buy now</div>',
    '<div class="advertisement">EXTRA buy now</div>',
    '<div class="ad-slot">EXTRA buy now</div>',
    '<div class="ad-container">EXTRA buy now</div>',
    '<ins class="adsbygoogle">EXTRA buy now</ins>',
    '<div data-ad-slot="top">EXTRA buy now</div>',
    '<div id="taboola-below-article">EXTRA buy now</div>',
    '<div class="OUTBRAIN">EXTRA buy now</div>',
  ])('removes an ad inside the article: %s', (extra) => {
    loadPage(articleWith(extra));
    const { text } = run();
    expect(text).toContain('glacier study number 25');
    expect(text).not.toContain('EXTRA');
  });

  it('removes navigation inside the article', () => {
    loadPage(articleWith('<nav><ul><li><a href="#h">EXTRA History</a></li></ul></nav>'));
    const { text } = run();
    expect(text).toContain('glacier study number 25');
    expect(text).not.toContain('EXTRA');
  });

  it.each(['Reader comments', 'Comments', 'Comment', '12 Comments', '1,024 Comments', 'Comments 12', 'Comments: 12', 'Comments (12)', '12 Responses', 'Replies (3)'])(
    'removes a last section titled %s',
    (title) => {
      loadPage(articleEndingWith(`<section><h2>${title}</h2><p>EXTRA I disagree.</p></section>`));
      const { text } = run();
      expect(text).toContain('glacier study number 25');
      expect(text).not.toContain('EXTRA');
    },
  );

  it.each([
    ['a Discussion section', articleWith(`<section class="discussion"><h2>Discussion</h2>${paragraph('kept')}</section>`)],
    ['a responses class', articleEndingWith(`<section class="responses"><h2>Responses to the crisis</h2>${paragraph('kept')}</section>`)],
    ['a title that only starts like comments', articleEndingWith(`<section><h2>Responses to the crisis</h2>${paragraph('kept')}</section>`)],
    ['a word that contains ad', articleWith(`<div class="adventure"><p>${sentence('kept', 1)}</p></div>`)],
    ['a heading deeper in the section', articleEndingWith(`<section><p>${sentence('kept', 1)}</p><h3>Comments</h3></section>`)],
    ['a Comments section mid-article', articleWith(`<section><h2>Comments</h2>${paragraph('kept')}</section>`)],
    ['a Responses section mid-article', articleWith(`<section><h2>Responses</h2>${paragraph('kept')}</section>`)],
    ['a last section titled only Responses', articleEndingWith(`<section><h2>Responses</h2>${paragraph('kept')}</section>`)],
    ['a last section titled only Replies', articleEndingWith(`<section><h2>Replies</h2>${paragraph('kept')}</section>`)],
  ])('keeps real content: %s', (_name, html) => {
    loadPage(html);
    expect(run().text).toContain('kept study number');
  });

  it.each([
    ['html', `<html class="ads"><head><title>T</title></head><body><article>${paragraph('kept')}${paragraph('kept', 10)}</article></body></html>`],
    ['body', `<html><head><title>T</title></head><body class="ad"><article>${paragraph('kept')}${paragraph('kept', 10)}</article></body></html>`],
  ])('keeps the page when %s carries an ad class', (_name, html) => {
    loadPage(html);
    expect(run().text).toContain('kept study number');
  });

  it.each([
    ['a nested list', `<ul><li>Fruit<ul><li>${'Apple is sweet. '.repeat(40)}</li></ul></li></ul>`, /Fruit\n\nApple/],
    ['text before a block', `<section>Intro ends here<p>${'Next comes. '.repeat(60)}</p></section>`, /here\n\nNext/],
    ['text after a block', `<section><p>${'Words here. '.repeat(50)}End</p>Tail text ${'more words. '.repeat(20)}</section>`, /End\n\nTail/],
    ['a summary', `<details><summary>Question</summary>Answer ${'text goes on. '.repeat(50)}</details>`, /Question\n\nAnswer/],
    ['a table caption', `<section>Intro ends<table><caption>Yearly results</caption><tr><td>${'Long cell text. '.repeat(50)}</td></tr></table></section>`, /ends\n\nYearly/],
    ['adjacent sections of bare text', `<div><article>${'First words here. '.repeat(30)}readers.</article><article>Second ${'more words here. '.repeat(30)}</article></div>`, /readers\.\n\nSecond/],
    ['a figure', `<div>${'Lead words here. '.repeat(30)}Caption intro<figure>Figure note</figure></div>`, /intro\n\nFigure/],
    ['a header and main', `<div><header>Headline here</header><main>Body ${'words go on. '.repeat(50)}</main></div>`, /here\n\nBody/],
    ['centered text', `<div><center>${'Some words. '.repeat(30)}words</center><center>Next ${'more words. '.repeat(30)}</center></div>`, /words\n\nNext/],
  ])('keeps words apart around %s', (_name, html, expected) => {
    loadPage(`<html><head><title>T</title></head><body><article>${html}</article></body></html>`);
    expect(run().text).toMatch(expected);
  });

  it('keeps paragraphs apart, with no words joined across a block', () => {
    loadPage(
      `<html><head><title>T</title></head><body><article><p>${sentence('alpha', 1).repeat(5)}</p><p>${sentence('beta', 2).repeat(5)}</p><ul><li>${sentence('gamma', 3).repeat(4)}</li><li>${sentence('delta', 4).repeat(4)}</li></ul></article></body></html>`,
    );
    const paragraphs = run().text.split('\n\n');
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0]).toMatch(/^The alpha/);
    expect(paragraphs[1]).toMatch(/^The beta/);
    expect(paragraphs[3]).toMatch(/^The delta/);
  });

  it('collapses the line breaks and spaces of the page source inside a paragraph', () => {
    const wrapped = sentence('alpha', 1).repeat(8).replaceAll(' ', '\n      ');
    loadPage(`<html><head><title>T</title></head><body><article><p>${wrapped}</p></article></body></html>`);
    expect(run().text).toBe(sentence('alpha', 1).repeat(8).trim());
  });

  it('counts the words of the extracted text', () => {
    loadPage(`<html><head><title>T</title></head><body><article>${paragraph('alpha')}</article></body></html>`);
    expect(run().wordCount).toBe(6 * sentence('alpha', 0).split(' ').length);
  });

  it('returns no text and no words when the page has no body text', () => {
    loadPage('<html><head><title>Empty</title></head><body></body></html>');
    expect(run()).toMatchObject({ text: '', wordCount: 0, isPdf: false });
  });
});

describe('video flag', () => {
  const page = (extra: string) =>
    `<html><head><title>T</title></head><body>${extra}<article>${paragraph('alpha')}${paragraph('alpha', 10)}</article></body></html>`;

  it.each([
    ['a video element', '<video src="/clip.mp4"></video>'],
    ['a YouTube embed', '<iframe src="https://www.youtube.com/embed/abc"></iframe>'],
    ['a private YouTube embed', '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>'],
    ['a Vimeo embed', '<iframe src="https://player.vimeo.com/video/1"></iframe>'],
  ])('is set for %s', (_name, extra) => {
    loadPage(page(extra));
    expect(run().hasVideo).toBe(true);
  });

  it.each([
    ['no media', ''],
    ['an image', '<img src="/a.png">'],
    ['an audio element', '<audio src="/a.mp3"></audio>'],
    ['an unrelated frame', '<iframe src="https://example.com/form"></iframe>'],
  ])('is not set for %s', (_name, extra) => {
    loadPage(page(extra));
    expect(run().hasVideo).toBe(false);
  });
});

describe('PDF detection', () => {
  it('flags a PDF and reads nothing from it', () => {
    loadPage('<html><body><embed type="application/pdf"></body></html>', 'application/pdf');
    expect(run()).toEqual({ text: '', wordCount: 0, hasVideo: false, isPdf: true });
  });
});
