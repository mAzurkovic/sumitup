import { Readability } from '@mozilla/readability';
import { countWords } from '@/lib/text';

export interface Extraction {
  text: string;
  wordCount: number;
  hasVideo: boolean;
  isPdf: boolean;
}

const BLOCKS =
  'address,article,aside,blockquote,br,caption,center,dd,details,div,dt,figcaption,figure,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,p,pre,section,summary,td,th,tr';
const VIDEOS =
  'video,iframe[src*="youtube.com"],iframe[src*="youtube-nocookie.com"],iframe[src*="vimeo.com"],iframe[src*="dailymotion.com"],iframe[src*="wistia."]';
// Exact markers only. A broad rule would delete real content, such as a "Discussion" section.
const NOT_CONTENT =
  'nav,.ad,.ads,.advert,.advertisement,.ad-slot,.ad-container,ins.adsbygoogle,[data-ad-slot],[id*="taboola" i],[class*="taboola" i],[id*="outbrain" i],[class*="outbrain" i]';
const SECTION_TITLES = 'section > h2:first-child,section > h3:first-child,section > h4:first-child';
const COUNT = String.raw`[\d,.]+`;
const COMMENTS_TITLE = new RegExp(
  `^(${COUNT}\\s+)?((reader|user|visitor)\\s+)?comments?(\\s*[:(]?\\s*${COUNT}\\)?)?$|^${COUNT}\\s+(responses|replies)$|^(responses|replies)\\s*\\(${COUNT}\\)$`,
  'i',
);

/** Readability misses these when they sit inside the article. */
function removeNonContent(page: Document) {
  page.querySelectorAll(NOT_CONTENT).forEach((element) => {
    if (element !== page.body && element !== page.documentElement) element.remove();
  });
  // Comments end a page, so a section with this title elsewhere is about something else.
  page.querySelectorAll(SECTION_TITLES).forEach((title) => {
    const section = title.parentElement!;
    if (!section.nextElementSibling && COMMENTS_TITLE.test(title.textContent!.trim())) section.remove();
  });
}

// Text content alone joins words on each side of a block boundary.
function paragraphsOf(root: Element): string {
  root.querySelectorAll(BLOCKS).forEach((block) => {
    block.before('\n\n');
    block.after('\n\n');
  });
  return root.textContent!
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

export default defineUnlistedScript((): Extraction => {
  if (document.contentType === 'application/pdf') return { text: '', wordCount: 0, hasVideo: false, isPdf: true };

  const page = document.cloneNode(true) as Document;
  removeNonContent(page);
  const reader = new Readability(page, { serializer: (node) => node as Element });
  const content = reader.parse()?.content;
  const text = content ? paragraphsOf(content) : '';
  return { text, wordCount: countWords(text), hasVideo: document.querySelector(VIDEOS) !== null, isPdf: false };
});
