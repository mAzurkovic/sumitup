import type { Page } from '@playwright/test';
import type { FakeProvider } from '../fake-provider';
import { ARTICLE_PARAGRAPHS, articlePage, longPage } from './pages';
import { expect, KEY, SelectionUi, test, type Extension } from './fixtures';

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
const SELECTED = ARTICLE_PARAGRAPHS[1]!;

/** An article with a paragraph of 19 words and one of 20. */
const selectionPage = () => articlePage({ extra: `<p id="nineteen">${words(19)}</p><p id="twenty">${words(20)}</p>` });

async function openSelectionPage(extension: Extension, fake: FakeProvider) {
  const tab = await extension.open(fake.page('/article', selectionPage()));
  return { tab, ui: new SelectionUi(tab) };
}

/** Selects a whole paragraph with a real triple click. */
const selectParagraph = (tab: Page, selector: string) => tab.locator(selector).click({ clickCount: 3 });

const chatBox = (panel: Page) => panel.getByLabel('Chat');

test.describe('highlight button', () => {
  test('shows for 20 selected words and not for 19, with no call', async ({ extension, fake }) => {
    await extension.saveKey();
    const { tab, ui } = await openSelectionPage(extension, fake);
    await selectParagraph(tab, '#nineteen');
    expect((await ui.part('.trigger')).shown).toBe(false);
    await selectParagraph(tab, '#twenty');
    expect(await ui.part('.trigger')).toMatchObject({ shown: true, text: 'Sum it up!' });
    expect(fake.requests).toEqual([]);
  });

  test('does not show for text in a field', async ({ extension, fake }) => {
    const tab = await extension.open(fake.page('/form', articlePage({ extra: `<textarea>${words(30)}</textarea>` })));
    const ui = new SelectionUi(tab);
    await selectParagraph(tab, 'p:nth-of-type(2)');
    expect((await ui.part('.trigger')).shown).toBe(true);
    await tab.locator('textarea').click({ clickCount: 3 });
    expect((await ui.part('.trigger')).shown).toBe(false);
  });
});

test.describe('popup', () => {
  test('summarizes only the selected text, at most 3 sentences, and closes on Esc', async ({ extension, fake }) => {
    await extension.saveKey();
    fake.script({ text: ['Chloroplasts absorb light.', ' The Calvin cycle makes sugar.'] });
    const { tab, ui } = await openSelectionPage(extension, fake);
    await selectParagraph(tab, 'p:nth-of-type(2)');
    await ui.click('.trigger');
    await expect.poll(async () => (await ui.part('.text')).text).toBe('Chloroplasts absorb light. The Calvin cycle makes sugar.');
    expect(await ui.part('.more')).toMatchObject({ shown: true, text: 'More' });

    const [call] = fake.calls;
    expect(call!.body!.system).toContain('at most 3 sentences');
    expect(call!.body!.messages[0]!.content).toContain(SELECTED);
    expect(call!.body!.messages[0]!.content).not.toContain(ARTICLE_PARAGRAPHS[0]);

    await tab.keyboard.press('Escape');
    expect((await ui.part('.popup')).shown).toBe(false);
  });

  test('closes on a click outside it', async ({ extension, fake }) => {
    await extension.saveKey();
    const { tab, ui } = await openSelectionPage(extension, fake);
    await selectParagraph(tab, 'p:nth-of-type(2)');
    await ui.click('.trigger');
    await expect.poll(async () => (await ui.part('.popup')).shown).toBe(true);
    await tab.mouse.click(5, 5);
    expect((await ui.part('.popup')).shown).toBe(false);
  });

  test('opens the panel on "More" with a selection summary at the panel level and chat about the selection', async ({
    extension,
    fake,
  }) => {
    await extension.saveKey();
    await extension.setLevel('medium');
    const { tab, ui } = await openSelectionPage(extension, fake);
    await selectParagraph(tab, 'p:nth-of-type(2)');
    await ui.click('.trigger');
    await expect.poll(async () => (await ui.part('.text')).text).not.toBe('');

    fake.script({ text: ['## Light\n- Selection summary.'] });
    await ui.click('.more');
    const panel = await extension.waitForPanel(await extension.tabIdOf(tab));
    await expect(panel.locator('h1')).toHaveText('Selected text summary');
    await expect(panel.locator('li')).toHaveText('Selection summary.');
    await expect(chatBox(panel)).toHaveAttribute('placeholder', 'Ask about this selection');
    const summaryCall = fake.calls.at(-1)!;
    expect(summaryCall.body!.system).toContain('grouped under short headings');
    expect(summaryCall.body!.messages[0]!.content).toContain(SELECTED);
    expect(summaryCall.body!.messages[0]!.content).not.toContain(ARTICLE_PARAGRAPHS[0]);
  });

  test('opens key setup when no key is saved, then summarizes the selection after a save', async ({ extension, fake }) => {
    const { tab, ui } = await openSelectionPage(extension, fake);
    await selectParagraph(tab, 'p:nth-of-type(2)');
    await ui.click('.trigger');
    const panel = await extension.waitForPanel(await extension.tabIdOf(tab));
    await expect(panel.locator('h1')).toHaveText('Add an API key to start');
    expect(fake.calls).toEqual([]);

    fake.script({ text: ['- Selection summary.'] });
    await panel.getByPlaceholder('Paste your key').fill(KEY);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.locator('h1')).toHaveText('Selected text summary');
    await expect(panel.locator('li')).toHaveText('Selection summary.');
    expect(fake.calls[0]!.body!.messages[0]!.content).toContain(SELECTED);
  });
});

test.describe('scope and chat', () => {
  async function selectionInPanel(extension: Extension, fake: FakeProvider) {
    await extension.saveKey();
    const { tab, ui } = await openSelectionPage(extension, fake);
    await selectParagraph(tab, 'p:nth-of-type(2)');
    await ui.click('.trigger');
    await expect.poll(async () => (await ui.part('.text')).text).not.toBe('');
    fake.script({ text: ['- Selection summary.'] });
    await ui.click('.more');
    const panel = await extension.waitForPanel(await extension.tabIdOf(tab));
    await expect(panel.locator('li')).toHaveText('Selection summary.');
    return { tab, panel };
  }

  test('switches to the whole page and clears chat', async ({ extension, fake }) => {
    const { panel } = await selectionInPanel(extension, fake);
    fake.script({ text: ['About the selection.'] }, { text: ['- Page summary.'] });
    await chatBox(panel).fill('What is absorbed?');
    await chatBox(panel).press('Enter');
    await expect(panel.locator('.message.assistant')).toHaveText('About the selection.');

    await panel.getByRole('button', { name: 'Summarize whole page' }).click();
    await expect(panel.locator('h1')).toHaveText('Page summary');
    await expect(panel.locator('li')).toHaveText('Page summary.');
    await expect(panel.locator('.message')).toHaveCount(0);
    expect(fake.calls.at(-1)!.body!.messages[0]!.content).toContain(ARTICLE_PARAGRAPHS[0]);
  });

  test('answers from the content with the history, and scrolls each new message into view', async ({ extension, fake }) => {
    await extension.saveKey();
    fake.script({ text: ['- Plants make sugar.'] });
    const tab = await extension.open(fake.page('/article', articlePage()));
    const panel = await extension.openPanel(tab);
    await expect(panel.locator('li')).toHaveText('Plants make sugar.');

    for (let turn = 1; turn <= 8; turn++) {
      fake.script({ text: [`Answer ${turn}. ${words(30)}`] });
      await chatBox(panel).fill(`Question ${turn}?`);
      await chatBox(panel).press('Enter');
      await expect(panel.locator('.message.assistant').last()).toContainText(`Answer ${turn}.`);
    }
    const lastCall = fake.calls.at(-1)!.body!;
    expect(lastCall.messages.at(-1)!.content).toContain('Question 8?');
    expect(lastCall.messages.map(({ content }) => content).join('\n')).toContain('Question 7?');
    expect(lastCall.system + JSON.stringify(lastCall.messages)).toContain(ARTICLE_PARAGRAPHS[0]!.slice(0, 60));

    const column = await panel.locator('.scroll').boundingBox();
    const newest = await panel.locator('.message').last().boundingBox();
    expect(newest!.y + newest!.height).toBeLessThanOrEqual(column!.y + column!.height + 1);
    expect(await panel.locator('.scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(panel.locator('h1')).toBeInViewport();
    await expect(panel.getByLabel('Detail level')).toBeInViewport();
    await expect(chatBox(panel)).toBeInViewport();
  });
});

test.describe('long page', () => {
  async function openLongPage(extension: Extension, fake: FakeProvider) {
    await extension.saveKey();
    const panel = await extension.openPanel(await extension.open(fake.page('/long', longPage())));
    await expect(panel.getByText(/This page is long\. Summarizing uses about [\d,]+ tokens on your key\./)).toBeVisible({ timeout: 20_000 });
    return panel;
  }

  test('asks first, and makes no call on Cancel', async ({ extension, fake }) => {
    const panel = await openLongPage(extension, fake);
    expect(fake.calls).toEqual([]);
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByText('Sum it up?')).toBeVisible();
    expect(fake.calls).toEqual([]);
  });

  test('summarizes every part and merges them on Continue', async ({ extension, fake }) => {
    test.setTimeout(60_000);
    const panel = await openLongPage(extension, fake);
    fake.script({ text: ['Part one.'] }, { text: ['Part two.'] }, { text: ['- Merged summary.'] });
    await panel.getByRole('button', { name: 'Continue' }).click();
    await expect(panel.locator('li')).toHaveText('Merged summary.', { timeout: 20_000 });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]!.body!.messages[0]!.content).toContain('Part one.');
    expect(fake.calls[2]!.body!.messages[0]!.content).toContain('Part two.');
  });
});
