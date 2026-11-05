import { REJECTED_KEY } from '../fake-provider';
import { ARTICLE_PARAGRAPHS, articlePage, NAV_TEXT } from './pages';
import { expect, KEY, test, type Extension } from './fixtures';
import type { FakeProvider } from '../fake-provider';
import type { Page } from '@playwright/test';

const SUMMARY = ['- Plants turn light', ' into chemical energy.'];

async function openArticle(extension: Extension, fake: FakeProvider, path = '/article') {
  return extension.open(fake.page(path, articlePage()));
}

async function summarized(extension: Extension, fake: FakeProvider) {
  await extension.saveKey();
  fake.script({ text: SUMMARY });
  const tab = await openArticle(extension, fake);
  const panel = await extension.openPanel(tab);
  await expect(panel.locator('li')).toHaveText('Plants turn light into chemical energy.');
  return { tab, panel };
}

const chatBox = (panel: Page) => panel.getByLabel('Chat');

test.describe('first use', () => {
  test('asks for a key, rejects a bad one, and starts the summary after a good one', async ({ extension, fake }) => {
    const tab = await openArticle(extension, fake);
    const panel = await extension.openPanel(tab);
    await expect(panel.locator('h1')).toHaveText('Add an API key to start');
    await expect(panel.getByRole('link', { name: 'Get a key from Anthropic' })).toBeVisible();
    await expect(chatBox(panel)).toBeDisabled();

    await panel.getByPlaceholder('Paste your key').fill(REJECTED_KEY);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByRole('alert')).toHaveText('API key rejected');
    expect(await extension.worker.evaluate(() => chrome.storage.local.get('keys'))).toEqual({});

    fake.script({ text: SUMMARY });
    await panel.getByPlaceholder('Paste your key').fill(KEY);
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.locator('h1')).toHaveText('Page summary');
    await expect(panel.locator('li')).toHaveText('Plants turn light into chemical energy.');
    expect(fake.calls.map(({ key }) => key)).toEqual([KEY]);
  });
});


test.describe('page summary', () => {
  test('shows Summarizing until the first text, then streams it with Stop', async ({ extension, fake }) => {
    await extension.saveKey();
    fake.script({ text: ['- Plants turn light'], gapMs: 1000, then: 'hold' });
    const panel = await extension.openPanel(await openArticle(extension, fake));
    await expect(panel.getByText('Summarizing')).toBeVisible();
    await expect(chatBox(panel)).toBeDisabled();
    await expect(panel.locator('li')).toHaveText('Plants turn light');
    await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(chatBox(panel)).toBeDisabled();
  });

  test('summarizes the main content at the cheapest model and Short, then opens chat', async ({ extension, fake }) => {
    const { panel } = await summarized(extension, fake);
    await expect(panel.getByRole('button', { name: 'Stop' })).toBeHidden();
    await expect(chatBox(panel)).toBeEnabled();
    const [call] = fake.calls;
    expect(call!.body!.model).toBe('claude-haiku-5-5');
    expect(call!.body!.system).toContain('3 to 5 bullets');
    expect(call!.body!.messages[0]!.content).toContain(ARTICLE_PARAGRAPHS[0]);
    expect(call!.body!.messages[0]!.content).not.toContain(NAV_TEXT);
  });

  test('makes a new summary for a new level, and shows a cached one with no call', async ({ extension, fake }) => {
    const { panel } = await summarized(extension, fake);
    fake.script({ text: ['## Light\n- Medium summary.'] });
    await panel.getByLabel('Detail level').selectOption('medium');
    await expect(panel.locator('h4')).toHaveText('Light');
    expect(fake.calls[1]!.body!.system).toContain('grouped under short headings');

    await panel.getByLabel('Detail level').selectOption('short');
    await expect(panel.locator('li')).toHaveText('Plants turn light into chemical energy.');
    expect(fake.calls).toHaveLength(2);
  });

  test('keeps the text as Incomplete on Stop, and makes a new summary on Retry', async ({ extension, fake }) => {
    await extension.saveKey();
    fake.script({ text: ['- Partial text'], then: 'hold' }, { text: SUMMARY });
    const panel = await extension.openPanel(await openArticle(extension, fake));
    await expect(panel.locator('li')).toHaveText('Partial text');
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(panel.getByText('Incomplete', { exact: true })).toBeVisible();
    await expect(chatBox(panel)).toBeEnabled();

    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.locator('li')).toHaveText('Plants turn light into chemical energy.');
    await expect(panel.getByText('Incomplete', { exact: true })).toBeHidden();
    expect(fake.calls).toHaveLength(2);
  });
});

test.describe('closing the panel', () => {
  test('reopens with the same summary and chat and no call', async ({ extension, fake }) => {
    const { tab, panel } = await summarized(extension, fake);
    fake.script({ text: ['Light.'] });
    await chatBox(panel).fill('What powers it?');
    await chatBox(panel).press('Enter');
    await expect(panel.locator('.message.assistant')).toHaveText('Light.');

    await extension.closePanel(panel, tab);
    const reopened = await extension.openPanel(tab);
    await expect(reopened.locator('li')).toHaveText('Plants turn light into chemical energy.');
    await expect(reopened.locator('.message')).toHaveText(['What powers it?', 'Light.']);
    expect(fake.calls).toHaveLength(2);
  });

  test('ends a summary in progress and keeps its text as Incomplete', async ({ extension, fake }) => {
    await extension.saveKey();
    fake.script({ text: ['- Partial text'], then: 'hold' });
    const tab = await openArticle(extension, fake);
    const panel = await extension.openPanel(tab);
    await expect(panel.locator('li')).toHaveText('Partial text');
    await extension.closePanel(panel, tab);

    const reopened = await extension.openPanel(tab);
    await expect(reopened.locator('li')).toHaveText('Partial text');
    await expect(reopened.getByText('Incomplete', { exact: true })).toBeVisible();
    await expect(reopened.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(fake.calls).toHaveLength(1);
  });
});

test('opens only on the tab where it was opened', async ({ extension, fake }) => {
  const { tab } = await summarized(extension, fake);
  const other = await extension.open(fake.page('/other', articlePage({ title: 'Other' })));
  const otherId = await extension.tabIdOf(other);
  expect(await extension.panelsNow(otherId)).toHaveLength(0);
  // With no default panel, a tab with no panel of its own has none.
  expect(await extension.worker.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), otherId)).not.toHaveProperty('path');
  expect(await extension.panelsNow(await extension.tabIdOf(tab))).toHaveLength(1);
});

test.describe('navigation', () => {
  test('clears the summary for a new page and offers a summary with no call', async ({ extension, fake }) => {
    const { tab, panel } = await summarized(extension, fake);
    await tab.goto(fake.page('/next', articlePage({ title: 'Next' })));
    await expect(panel.getByText('New page. Sum it up?')).toBeVisible();
    await expect(panel.locator('li')).toHaveCount(0);
    await expect(chatBox(panel)).toBeDisabled();
    expect(fake.calls).toHaveLength(1);

    fake.script({ text: ['- Next page.'] });
    await panel.getByRole('button', { name: 'Sum it up' }).click();
    await expect(panel.locator('li')).toHaveText('Next page.');
  });

  test('counts a move to a page it cannot read as a new page', async ({ extension, fake }) => {
    const { tab, panel } = await summarized(extension, fake);
    await tab.goto('chrome://version');
    await expect(panel.getByText('New page. Sum it up?')).toBeVisible();
    await panel.getByRole('button', { name: 'Sum it up' }).click();
    await expect(panel.getByRole('alert')).toHaveText("Sum it up can't read this page");
    expect(fake.calls).toHaveLength(1);
  });

  test('ignores a change to the fragment only', async ({ extension, fake }) => {
    const { tab, panel } = await summarized(extension, fake);
    await tab.evaluate(() => {
      location.hash = 'section-2';
    });
    await tab.waitForTimeout(500);
    await expect(panel.locator('li')).toHaveText('Plants turn light into chemical energy.');
  });

  test('counts a single-page app route change as a new page', async ({ extension, fake }) => {
    const { tab, panel } = await summarized(extension, fake);
    await tab.evaluate(() => history.pushState(null, '', '/article/comments'));
    await expect(panel.getByText('New page. Sum it up?')).toBeVisible();
    expect(fake.calls).toHaveLength(1);
  });

  test('keeps the summary on a reload, with no call', async ({ extension, fake }) => {
    const { tab, panel } = await summarized(extension, fake);
    await tab.reload();
    await tab.waitForTimeout(500);
    await expect(panel.locator('li')).toHaveText('Plants turn light into chemical energy.');
    expect(fake.calls).toHaveLength(1);
  });
});
