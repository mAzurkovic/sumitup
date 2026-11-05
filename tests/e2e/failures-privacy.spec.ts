import { chromium, type Page } from '@playwright/test';
import type { FakeProvider, Reply } from '../fake-provider';
import { ARTICLE_PARAGRAPHS, articlePage } from './pages';
import { expect, SelectionUi, test, type Extension } from './fixtures';

async function panelWith(extension: Extension, fake: FakeProvider, ...replies: Reply[]) {
  await extension.saveKey();
  fake.script(...replies);
  const tab = await extension.open(fake.page('/article', articlePage()));
  return { tab, panel: await extension.openPanel(tab) };
}

const alert = (panel: Page) => panel.getByRole('alert');
const retry = (panel: Page) => panel.getByRole('button', { name: 'Retry' });

test.describe('failures with Retry', () => {
  const cases: [string, Reply, string][] = [
    ['a rate limit', { status: 429 }, 'Provider limit reached'],
    ['a payment error', { status: 402 }, 'Provider limit reached'],
    ['no credit', { status: 400, body: '{"type":"error","error":{"message":"Your credit balance is too low"}}' }, 'Provider limit reached'],
    ['a server error', { status: 500 }, 'Provider unavailable'],
    ['a stream cut off before any text', { then: 'end' }, 'Provider unavailable'],
    ['any other request error', { status: 422 }, 'Provider rejected the request'],
  ];

  for (const [name, reply, message] of cases) {
    test(`shows "${message}" for ${name}, and makes no call until Retry`, async ({ extension, fake }) => {
      const { panel } = await panelWith(extension, fake, reply, { text: ['- Recovered.'] });
      await expect(alert(panel)).toContainText(message);
      await panel.waitForTimeout(1500);
      expect(fake.calls).toHaveLength(1);
      await retry(panel).click();
      await expect(panel.locator('li')).toHaveText('Recovered.');
      expect(fake.calls).toHaveLength(2);
    });
  }

  test('shows "Provider unavailable" when no text comes within 30 seconds', async ({ extension, fake }) => {
    test.setTimeout(60_000);
    const { panel } = await panelWith(extension, fake, { then: 'hold' });
    await expect(panel.getByText('Summarizing')).toBeVisible();
    await expect(alert(panel)).toContainText('Provider unavailable', { timeout: 35_000 });
    await expect(retry(panel)).toBeVisible();
  });

  test('shows "No connection" when offline', async ({ extension, fake }) => {
    const { panel } = await panelWith(extension, fake, { text: ['- Online summary.'] });
    await expect(panel.locator('li')).toHaveText('Online summary.');
    // Opening a page resets the worker's offline state, so the network goes off once the panel is open.
    await extension.context.setOffline(true);
    expect(await extension.worker.evaluate(() => navigator.onLine)).toBe(false);
    await panel.getByLabel('Detail level').selectOption('medium');
    await expect(alert(panel)).toContainText('No connection');
    await expect(panel.locator('li')).toHaveText('Online summary.');
    await extension.context.setOffline(false);
    fake.script({ text: ['- Back online.'] });
    await retry(panel).click();
    await expect(panel.locator('li')).toHaveText('Back online.');
  });
});

test.describe('text cut off mid-stream', () => {
  for (const [name, reply] of [
    ['a dropped connection', { text: ['- Partial'], then: 'drop' }],
    ['an error inside the stream', { text: ['- Partial'], then: 'errorEvent' }],
    ['the output limit', { text: ['- Partial'], stop: 'max_tokens' }],
  ] as [string, Reply][]) {
    test(`keeps the text as Incomplete with Retry after ${name}`, async ({ extension, fake }) => {
      const { panel } = await panelWith(extension, fake, reply);
      await expect(panel.locator('li')).toHaveText('Partial');
      await expect(panel.getByText('Incomplete', { exact: true })).toBeVisible();
      await expect(retry(panel)).toBeVisible();
    });
  }
});

test.describe('failures with a menu link', () => {
  for (const [name, reply, message, link] of [
    ['a rejected key', { status: 401 }, 'API key rejected', 'Check your key'],
    ['a retired model', { status: 404 }, 'Model unavailable', 'Choose another model'],
    ['a refusal', { stop: 'refusal' }, 'Provider declined this content', 'Choose another model'],
  ] as [string, Reply, string, string][]) {
    test(`shows "${message}" for ${name}, with a link that opens the model menu and no Retry`, async ({ extension, fake }) => {
      const { panel } = await panelWith(extension, fake, reply);
      await expect(alert(panel)).toContainText(message);
      await expect(retry(panel)).toHaveCount(0);
      await panel.getByRole('button', { name: link }).click();
      await expect(panel.locator('#model-menu')).toBeVisible();
    });
  }

  test('keeps refused text, with chat closed and no Retry', async ({ extension, fake }) => {
    const { panel } = await panelWith(extension, fake, { text: ['- Some text'], stop: 'refusal' });
    await expect(panel.locator('li')).toHaveText('Some text');
    await expect(alert(panel)).toContainText('Provider declined this content');
    await expect(retry(panel)).toHaveCount(0);
    await expect(panel.getByLabel('Chat')).toBeDisabled();
  });
});

test('shows "Sum it up can\'t read this page" on a page Chrome blocks, with no call', async ({ extension, fake }) => {
  await extension.saveKey();
  const tab = await extension.context.newPage();
  await tab.goto('chrome://version');
  const panel = await extension.openPanel(tab);
  await expect(alert(panel)).toHaveText("Sum it up can't read this page");
  expect(fake.calls).toEqual([]);
});

test('shows "Not enough text to summarize" for a short page, with no call', async ({ extension, fake }) => {
  await extension.saveKey();
  const tab = await extension.open(fake.page('/short', articlePage({ paragraphs: ['Only a few words live here.'] })));
  const panel = await extension.openPanel(tab);
  await expect(alert(panel)).toHaveText('Not enough text to summarize');
  expect(fake.calls).toEqual([]);
});

test('keeps the summary on screen when a later request fails', async ({ extension, fake }) => {
  const { panel } = await panelWith(extension, fake, { text: ['- First summary.'] }, { status: 429 });
  await expect(panel.locator('li')).toHaveText('First summary.');
  await panel.getByLabel('Detail level').selectOption('medium');
  await expect(alert(panel)).toContainText('Provider limit reached');
  await expect(panel.locator('li')).toHaveText('First summary.');
});

test('keeps the text of a run that a new request replaced, when the new request fails', async ({ extension, fake }) => {
  const { panel } = await panelWith(extension, fake, { text: ['- Partial text'], then: 'hold' }, { status: 429 });
  await expect(panel.locator('li')).toHaveText('Partial text');
  await panel.getByLabel('Detail level').selectOption('medium');
  await expect(alert(panel)).toContainText('Provider limit reached');
  await expect(panel.locator('li')).toHaveText('Partial text');
  await expect(panel.getByRole('button', { name: 'Sum it up' })).toHaveCount(0);
});

test('shows a failure in the popup, with Retry', async ({ extension, fake }) => {
  await extension.saveKey();
  fake.script({ status: 429 });
  const tab = await extension.open(fake.page('/article', articlePage()));
  const ui = new SelectionUi(tab);
  await tab.locator('p').nth(1).click({ clickCount: 3 });
  await ui.click('.trigger');
  await expect.poll(async () => (await ui.part('.status')).text).toBe('Provider limit reached');
  expect((await ui.part('.retry')).shown).toBe(true);
});

test('opens the panel and its menu on a popup failure, with no new call', async ({ extension, fake }) => {
  await extension.saveKey();
  fake.script({ status: 401 });
  const tab = await extension.open(fake.page('/article', articlePage()));
  const ui = new SelectionUi(tab);
  await tab.locator('p').nth(1).click({ clickCount: 3 });
  await ui.click('.trigger');
  await expect.poll(async () => (await ui.part('.more')).text).toBe('Check your key');
  await ui.click('.more');
  const panel = await extension.waitForPanel(await extension.tabIdOf(tab));
  await expect(alert(panel)).toContainText('API key rejected');
  await expect(panel.locator('#model-menu')).toBeVisible();
  expect(fake.calls).toHaveLength(1);
});

test.describe('speed', () => {
  test('loads the panel within 200ms of the click', async ({ extension, fake }) => {
    await extension.saveKey();
    const tab = await extension.open(fake.page('/article', articlePage()));
    const tabId = await extension.tabIdOf(tab);
    const helper = await extension.context.newPage();
    await helper.goto(`chrome-extension://${extension.id}/helper.html?tabId=${tabId}`);
    await helper.evaluate(() => {
      document.getElementById('open')!.addEventListener('click', () => localStorage.setItem('clickedAt', String(Date.now())), true);
    });
    await helper.click('#open');
    const panel = await extension.waitForPanel(tabId);
    const clickedAt = Number(await helper.evaluate(() => localStorage.getItem('clickedAt')));
    // Chrome reports no paint timing for a side panel, so this measures to the end of its page load.
    const loadedAt = await panel.evaluate(
      () => performance.timeOrigin + (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd,
    );
    expect(loadedAt - clickedAt).toBeLessThan(200);
  });

  test('shows the highlight button within 200ms of the selection', async ({ extension, fake }) => {
    const tab = await extension.open(fake.page('/article', articlePage()));
    // Runs before the content script's listener, and the window listener runs after it.
    await tab.evaluate(() => {
      document.addEventListener('mouseup', () => (window.__releasedAt = performance.now()), true);
      window.addEventListener('mouseup', () => (window.__handledAt = performance.now()));
    });
    await tab.locator('p').nth(1).click({ clickCount: 3 });
    expect((await new SelectionUi(tab).part('.trigger')).shown).toBe(true);
    const elapsed = await tab.evaluate(() => window.__handledAt! - window.__releasedAt!);
    expect(elapsed).toBeLessThan(200);
  });

  test('adds at most 50ms to page load', async ({ extension, fake }) => {
    const url = fake.page('/article', articlePage());
    const loadTime = async (page: Page) => {
      const times: number[] = [];
      for (let run = 0; run < 5; run++) {
        await page.goto(`${url}?run=${run}`);
        times.push(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd));
      }
      return times.sort((a, b) => a - b)[2]!;
    };
    const plain = await chromium.launch({ channel: 'chromium', headless: true });
    const withoutExtension = await loadTime(await plain.newPage());
    await plain.close();
    const withExtension = await loadTime(await extension.context.newPage());
    expect(withExtension - withoutExtension).toBeLessThan(50);
  });
});

test.describe('no call before a click', () => {
  test('sends nothing to the provider on page load, navigation, and selection', async ({ extension, fake }) => {
    await extension.saveKey();
    const tab = await extension.open(fake.page('/article', articlePage()));
    await tab.goto(fake.page('/next', articlePage({ title: 'Next' })));
    await tab.evaluate(() => history.pushState(null, '', '/next/route'));
    await tab.locator('p').nth(1).click({ clickCount: 3 });
    expect((await new SelectionUi(tab).part('.trigger')).shown).toBe(true);
    await tab.waitForTimeout(500);
    expect(fake.requests).toEqual([]);
  });

  test('sends nothing on navigation with the panel open', async ({ extension, fake }) => {
    const { tab, panel } = await panelWith(extension, fake, { text: ['- Summary.'] });
    await expect(panel.locator('li')).toHaveText('Summary.');
    const before = fake.requests.length;
    await tab.goto(fake.page('/next', articlePage({ title: 'Next', paragraphs: ARTICLE_PARAGRAPHS.slice(1) })));
    await expect(panel.getByText('New page. Sum it up?')).toBeVisible();
    await tab.waitForTimeout(500);
    expect(fake.requests).toHaveLength(before);
  });
});

declare global {
  interface Window {
    __releasedAt?: number;
    __handledAt?: number;
  }
}
