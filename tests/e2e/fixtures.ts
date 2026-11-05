import { test as base, chromium, type Browser, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider } from '../fake-provider';

export { expect } from '@playwright/test';



export const KEY = 'sk-ant-test-key-1234';
const CDP_PORT = 9401;

/**
 * Headless Chrome has no toolbar. This page does what a toolbar click does in the worker,
 * from a real click, because the side panel opens only in response to one.
 */
const HELPER_SCRIPT = `document.getElementById('open').onclick = async () => {
  const tabId = Number(new URLSearchParams(location.search).get('tabId'));
  chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html?tabId=' + tabId, enabled: true });
  await chrome.sidePanel.open({ tabId });
  await chrome.tabs.update(tabId, { active: true });
};`;

export class Extension {
  private readonly shown = new Set<string>();
  private readonly connections: Browser[] = [];
  private helper?: Page;

  constructor(
    readonly context: BrowserContext,
    readonly worker: Worker,
  ) {}

  get id(): string {
    return new URL(this.worker.url()).host;
  }

  async open(url: string): Promise<Page> {
    const tab = await this.context.newPage();
    await tab.goto(url);
    return tab;
  }

  async tabIdOf(tab: Page): Promise<number> {
    await tab.bringToFront();
    return this.worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!.id!);
  }

  saveKey(key = KEY): Promise<void> {
    return this.worker.evaluate((key) => chrome.storage.local.set({ keys: { anthropic: key } }), key);
  }

  setLevel(level: string): Promise<void> {
    return this.worker.evaluate(
      (level) => chrome.storage.local.set({ settings: { provider: 'anthropic', modelByProvider: {}, level } }),
      level,
    );
  }

  /** Opens the side panel on the tab, as a toolbar click does, and returns the panel page. */
  async openPanel(tab: Page): Promise<Page> {
    const tabId = await this.tabIdOf(tab);
    this.helper ??= await this.context.newPage();
    await this.helper.goto(`chrome-extension://${this.id}/helper.html?tabId=${tabId}`);
    await this.helper.click('#open');
    return this.waitForPanel(tabId);
  }

  /**
   * Side panels are not pages of the test's own context, and a DevTools connection lists only the panels
   * open when it connects, so each look makes a new connection.
   */
  private async pagesNow(): Promise<{ page: Page; targetId: string }[]> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    this.connections.push(browser);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const found = await Promise.all(
      pages.map(async (page) => {
        try {
          const session = await page.context().newCDPSession(page);
          const { targetInfo } = (await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
          return [{ page, targetId: targetInfo.targetId }];
        } catch {
          // The page closed after the listing, as a panel does while it closes.
          return [];
        }
      }),
    );
    return found.flat();
  }

  /** The panel Chrome opened for the tab, other than any panel already returned. */
  async waitForPanel(tabId: number): Promise<Page> {
    for (let tries = 0; tries < 50; tries++) {
      const panel = (await this.panelsNow(tabId)).find(({ targetId }) => !this.shown.has(targetId));
      if (panel) {
        this.shown.add(panel.targetId);
        await panel.page.locator('h1').waitFor();
        return panel.page;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No side panel opened for tab ${tabId}`);
  }

  /** Closes the panel with its chevron, and waits until Chrome has closed it. */
  async closePanel(panel: Page, tab: Page): Promise<void> {
    const tabId = await this.tabIdOf(tab);
    await panel.getByRole('button', { name: 'Close panel' }).click();
    for (let tries = 0; tries < 50; tries++) {
      if (!(await this.panelsNow(tabId)).length) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`The side panel on tab ${tabId} did not close`);
  }

  /** Panels open now on the tab. */
  async panelsNow(tabId: number): Promise<{ page: Page; targetId: string }[]> {
    return (await this.pagesNow()).filter(({ page }) => page.url().endsWith(`sidepanel.html?tabId=${tabId}`));
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map((browser) => browser.close()));
    await this.context.close();
  }
}

export const test = base.extend<{ extension: Extension }, { fake: FakeProvider }>({
  fake: [
    async ({}, use) => {
      const fake = new FakeProvider();
      await fake.start();
      await use(fake);
      await fake.stop();
    },
    { scope: 'worker' },
  ],

  extension: async ({ fake }, use) => {
    fake.reset();
    const dir = mkdtempSync(join(tmpdir(), 'sum-it-up-'));
    cpSync('dist/chrome-mv3-test', dir, { recursive: true });
    writeFileSync(join(dir, 'helper.html'), '<button id="open">Open</button><script src="helper.js"></script>');
    writeFileSync(join(dir, 'helper.js'), HELPER_SCRIPT);
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, `--remote-debugging-port=${CDP_PORT}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extension = new Extension(context, worker);
    await use(extension);
    await extension.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

interface ShadowPart {
  shown: boolean;
  text: string;
  className: string;
  center?: { x: number; y: number };
}

/** The highlight button and popup sit in a closed shadow root, which only DevTools can reach. */
export class SelectionUi {
  constructor(private readonly tab: Page) {}

  async part(selector: string): Promise<ShadowPart> {
    const session = await this.tab.context().newCDPSession(this.tab);
    try {
      const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
      const host = findNode(root, (node) => node.nodeName === 'SUM-IT-UP');
      const shadow = host?.shadowRoots?.[0];
      if (!shadow) return { shown: false, text: '', className: '' };
      const { nodeId } = (await session.send('DOM.querySelector', { nodeId: shadow.nodeId, selector })) as { nodeId: number };
      const { object } = (await session.send('DOM.resolveNode', { nodeId })) as { object: { objectId: string } };
      const { result } = (await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
          const box = this.getBoundingClientRect();
          const shown = !this.closest('[hidden]') && box.width > 0;
          return { shown, text: this.textContent, className: this.className,
            center: shown ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined };
        }`,
        returnByValue: true,
      })) as { result: { value: ShadowPart } };
      return result.value;
    } finally {
      await session.detach();
    }
  }

  /** A real mouse click, as a person makes it. */
  async click(selector: string): Promise<void> {
    const { center } = await this.part(selector);
    if (!center) throw new Error(`${selector} is not shown`);
    await this.tab.mouse.click(center.x, center.y);
  }
}

interface DomNode {
  nodeId: number;
  nodeName: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

function findNode(node: DomNode, match: (node: DomNode) => boolean): DomNode | undefined {
  if (match(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}
