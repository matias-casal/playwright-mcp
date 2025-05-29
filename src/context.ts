/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as playwright from 'playwright';

import { callOnPageNoTrace, waitForCompletion } from './tools/utils.js';
import { ManualPromise } from './manualPromise.js';
import { Tab } from './tab.js';
import { outputFile } from './config.js';

import type { ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { ModalState, Tool, ToolActionResult } from './tools/tool.js';
import type { FullConfig } from './config.js';

type PendingAction = {
  dialogShown: ManualPromise<void>;
};

type BrowserContextAndBrowser = {
  browser?: playwright.Browser;
  browserContext: playwright.BrowserContext;
};

export class Context {
  readonly tools: Tool[];
  readonly config: FullConfig;
  private _browserContextPromise: Promise<BrowserContextAndBrowser> | undefined;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _modalStates: (ModalState & { tab: Tab })[] = [];
  private _pendingAction: PendingAction | undefined;
  private _downloads: {
    download: playwright.Download;
    finished: boolean;
    outputFile: string;
  }[] = [];
  clientVersion: { name: string; version: string } | undefined;

  constructor(tools: Tool[], config: FullConfig) {
    this.tools = tools;
    this.config = config;
  }

  clientSupportsImages(): boolean {
    if (this.config.imageResponses === 'allow') return true;
    if (this.config.imageResponses === 'omit') return false;
    return !this.clientVersion?.name.includes('cursor');
  }

  modalStates(): ModalState[] {
    return this._modalStates;
  }

  setModalState(modalState: ModalState, inTab: Tab) {
    this._modalStates.push({ ...modalState, tab: inTab });
  }

  clearModalState(modalState: ModalState) {
    this._modalStates = this._modalStates.filter(state => state !== modalState);
  }

  modalStatesMarkdown(): string[] {
    const result: string[] = ['### Modal state'];
    if (this._modalStates.length === 0) result.push('- There is no modal state present');
    for (const state of this._modalStates) {
      const tool = this.tools.find(tool => tool.clearsModalState === state.type);
      result.push(`- [${state.description}]: can be handled by the "${tool?.schema.name}" tool`);
    }
    return result;
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No current snapshot available. Capture a snapshot of navigate to a new location first.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const { browserContext } = await this._ensureBrowserContext();
    const page = await browserContext.newPage();
    this._currentTab = this._tabs.find(t => t.page === page)!;
    return this._currentTab;
  }

  async selectTab(index: number) {
    this._currentTab = this._tabs[index - 1];
    await this._currentTab.page.bringToFront();
  }

  async ensureTab(): Promise<Tab> {
    const { browserContext } = await this._ensureBrowserContext();
    if (!this._currentTab) await browserContext.newPage();
    return this._currentTab!;
  }

  async listTabsMarkdown(): Promise<string> {
    if (!this._tabs.length) return '### No tabs open';
    const lines: string[] = ['### Open tabs'];
    for (let i = 0; i < this._tabs.length; i++) {
      const tab = this._tabs[i];
      const title = await tab.title();
      const url = tab.page.url();
      const current = tab === this._currentTab ? ' (current)' : '';
      lines.push(`- ${i + 1}:${current} [${title}] (${url})`);
    }
    return lines.join('\n');
  }

  async closeTab(index: number | undefined) {
    const tab = index === undefined ? this._currentTab : this._tabs[index - 1];
    await tab?.page.close();
    return await this.listTabsMarkdown();
  }

  async run(tool: Tool, params: Record<string, unknown> | undefined) {
    // Tab management is done outside of the action() call.
    const toolResult = await tool.handle(this, tool.schema.inputSchema.parse(params || {}));
    const { code, action, waitForNetwork, captureSnapshot, resultOverride } = toolResult;
    const racingAction = action ? () => this._raceAgainstModalDialogs(action) : undefined;

    if (resultOverride) return resultOverride;

    // Allow browser_restart and browser_close to work even without open tabs
    const allowWithoutTabs = ['browser_restart', 'browser_close'].includes(tool.schema.name);

    if (!this._currentTab && !allowWithoutTabs) {
      return {
        content: [
          {
            type: 'text',
            text: 'No open pages available. Use the "browser_navigate" tool to navigate to a page first.',
          },
        ],
      };
    }

    // For tools that don't require tabs, we can skip the tab-dependent logic
    if (!this._currentTab && allowWithoutTabs) {
      const result: string[] = [];
      result.push(`- Ran Playwright code:
\`\`\`js
${code.join('\n')}
\`\`\`
`);

      return {
        content: [
          {
            type: 'text',
            text: result.join('\n'),
          },
        ],
      };
    }

    const tab = this.currentTabOrDie();
    // TODO: race against modal dialogs to resolve clicks.
    let actionResult: { content?: (ImageContent | TextContent)[] } | undefined;
    try {
      if (waitForNetwork)
        actionResult = (await waitForCompletion(this, tab, async () => racingAction?.())) ?? undefined;
      else actionResult = (await racingAction?.()) ?? undefined;
    } finally {
      if (captureSnapshot && !this._javaScriptBlocked()) await tab.captureSnapshot();
    }

    const result: string[] = [];
    result.push(`- Ran Playwright code:
\`\`\`js
${code.join('\n')}
\`\`\`
`);

    if (this.modalStates().length) {
      result.push(...this.modalStatesMarkdown());
      return {
        content: [
          {
            type: 'text',
            text: result.join('\n'),
          },
        ],
      };
    }

    if (this._downloads.length) {
      result.push('', '### Downloads');
      for (const entry of this._downloads) {
        if (entry.finished)
          result.push(`- Downloaded file ${entry.download.suggestedFilename()} to ${entry.outputFile}`);
        else result.push(`- Downloading file ${entry.download.suggestedFilename()} ...`);
      }
      result.push('');
    }

    if (this.tabs().length > 1) result.push(await this.listTabsMarkdown(), '');

    if (this.tabs().length > 1) result.push('### Current tab');

    result.push(`- Page URL: ${tab.page.url()}`, `- Page Title: ${await tab.title()}`);

    if (captureSnapshot && tab.hasSnapshot()) result.push(tab.snapshotOrDie().text());

    const content = actionResult?.content ?? [];

    return {
      content: [
        ...content,
        {
          type: 'text',
          text: result.join('\n'),
        },
      ],
    };
  }

  async waitForTimeout(time: number) {
    if (!this._currentTab || this._javaScriptBlocked()) {
      await new Promise(f => setTimeout(f, time));
      return;
    }

    await callOnPageNoTrace(this._currentTab.page, page => {
      return page.evaluate(() => new Promise(f => setTimeout(f, 1000)));
    });
  }

  private async _raceAgainstModalDialogs(action: () => Promise<ToolActionResult>): Promise<ToolActionResult> {
    this._pendingAction = {
      dialogShown: new ManualPromise(),
    };

    let result: ToolActionResult | undefined;
    try {
      await Promise.race([action().then(r => (result = r)), this._pendingAction.dialogShown]);
    } finally {
      this._pendingAction = undefined;
    }
    return result;
  }

  private _javaScriptBlocked(): boolean {
    return this._modalStates.some(state => state.type === 'dialog');
  }

  dialogShown(tab: Tab, dialog: playwright.Dialog) {
    this.setModalState(
      {
        type: 'dialog',
        description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
        dialog,
      },
      tab
    );
    this._pendingAction?.dialogShown.resolve();
  }

  async downloadStarted(tab: Tab, download: playwright.Download) {
    const entry = {
      download,
      finished: false,
      outputFile: await outputFile(this.config, download.suggestedFilename()),
    };
    this._downloads.push(entry);
    await download.saveAs(entry.outputFile);
    entry.finished = true;
  }

  private _onPageCreated(page: playwright.Page) {
    const tab = new Tab(this, page, tab => this._onPageClosed(tab));
    this._tabs.push(tab);
    if (!this._currentTab) this._currentTab = tab;
  }

  private _onPageClosed(tab: Tab) {
    this._modalStates = this._modalStates.filter(state => state.tab !== tab);
    const index = this._tabs.indexOf(tab);
    if (index === -1) return;
    this._tabs.splice(index, 1);

    if (this._currentTab === tab) this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
    if (!this._tabs.length) void this.close();
  }

  async close() {
    if (!this._browserContextPromise) return;

    const promise = this._browserContextPromise;
    this._browserContextPromise = undefined;

    await promise.then(async ({ browserContext, browser }) => {
      if (this.config.saveTrace) await browserContext.tracing.stop();
      await browserContext
        .close()
        .then(async () => {
          await browser?.close();
        })
        .catch(() => {});
    });
  }

  async resetBrowserContext(cleanProfile: boolean = false) {
    // Close current context if it exists
    await this.close();

    // If requested, clean the profile directory to fix corruption issues
    if (
      cleanProfile &&
      !this.config.browser?.isolated &&
      !this.config.browser?.remoteEndpoint &&
      !this.config.browser?.cdpEndpoint
    ) {
      try {
        const userDataDir =
          this.config.browser?.userDataDir ??
          (await createUserDataDir({
            ...this.config.browser,
            browserName: this.config.browser?.browserName ?? 'chromium',
          }));

        // Only clean if it's in the standard cache location (safety check)
        const cacheDirectory =
          process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Caches')
            : process.platform === 'linux'
              ? process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
              : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

        if (userDataDir.startsWith(path.join(cacheDirectory, 'ms-playwright'))) {
          // Cleaning corrupted profile directory
          await fs.promises.rm(userDataDir, { recursive: true, force: true });
        }
      } catch (error: any) {
        // Failed to clean profile directory - continuing anyway
      }
    }

    // Clear any existing promise to force recreation
    this._browserContextPromise = undefined;
    // Clear tabs and reset state
    this._tabs = [];
    this._currentTab = undefined;
    this._modalStates = [];
    this._downloads = [];
  }

  private async _setupRequestInterception(context: playwright.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      await context.route('**', route => route.abort('blockedbyclient'));

      for (const origin of this.config.network.allowedOrigins)
        await context.route(`*://${origin}/**`, route => route.continue());
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        await context.route(`*://${origin}/**`, route => route.abort('blockedbyclient'));
    }
  }

  private _ensureBrowserContext() {
    if (!this._browserContextPromise) {
      this._browserContextPromise = this._setupBrowserContext();
      const currentPromise = this._browserContextPromise;
      this._browserContextPromise.catch(error => {
        if (this._browserContextPromise === currentPromise) {
          this._browserContextPromise = undefined;
        }
        throw error;
      });
    }
    return this._browserContextPromise;
  }

  private async _setupBrowserContext(): Promise<BrowserContextAndBrowser> {
    const { browser, browserContext } = await this._createBrowserContext();
    await this._setupRequestInterception(browserContext);
    for (const page of browserContext.pages()) this._onPageCreated(page);
    browserContext.on('page', page => this._onPageCreated(page));
    if (this.config.saveTrace) {
      await browserContext.tracing.start({
        name: 'trace',
        screenshots: false,
        snapshots: true,
        sources: false,
      });
    }
    return { browser, browserContext };
  }

  private async _createBrowserContext(): Promise<BrowserContextAndBrowser> {
    if (this.config.browser?.remoteEndpoint) {
      if (typeof this.config.browser.remoteEndpoint !== 'string' || this.config.browser.remoteEndpoint.trim() === '') {
        throw new Error(`Invalid remote endpoint: ${this.config.browser.remoteEndpoint}. Must be a valid URL string.`);
      }

      const url = new URL(this.config.browser.remoteEndpoint);
      if (this.config.browser.browserName) url.searchParams.set('browser', this.config.browser.browserName);
      if (this.config.browser.launchOptions)
        url.searchParams.set('launch-options', JSON.stringify(this.config.browser.launchOptions));
      const browser = await playwright[this.config.browser?.browserName ?? 'chromium'].connect(String(url));
      const browserContext = await browser.newContext();
      return { browser, browserContext };
    }

    if (this.config.browser?.cdpEndpoint) {
      if (typeof this.config.browser.cdpEndpoint !== 'string' || this.config.browser.cdpEndpoint.trim() === '') {
        throw new Error(`Invalid CDP endpoint: ${this.config.browser.cdpEndpoint}. Must be a valid URL string.`);
      }

      const browser = await playwright.chromium.connectOverCDP(this.config.browser.cdpEndpoint);
      const browserContext = this.config.browser.isolated ? await browser.newContext() : browser.contexts()[0];
      return { browser, browserContext };
    }

    return this.config.browser?.isolated
      ? await createIsolatedContext(this.config.browser)
      : await launchPersistentContext(this.config.browser);
  }
}

async function createIsolatedContext(browserConfig: FullConfig['browser']): Promise<BrowserContextAndBrowser> {
  try {
    const browserName = browserConfig?.browserName ?? 'chromium';
    const browserType = playwright[browserName];
    const browser = await browserType.launch(browserConfig.launchOptions);
    const browserContext = await browser.newContext(browserConfig.contextOptions);
    return { browser, browserContext };
  } catch (error: any) {
    if (error.message.includes("Executable doesn't exist"))
      throw new Error(
        `Browser specified in your config is not installed. Either install it (likely) or change the config.`
      );
    throw new Error(`Failed to create isolated browser context: ${error.message}`);
  }
}

async function launchPersistentContext(browserConfig: FullConfig['browser']): Promise<BrowserContextAndBrowser> {
  try {
    const browserName = browserConfig.browserName ?? 'chromium';
    const userDataDir = browserConfig.userDataDir ?? (await createUserDataDir({ ...browserConfig, browserName }));
    const browserType = playwright[browserName];
    const browserContext = await browserType.launchPersistentContext(userDataDir, {
      ...browserConfig.launchOptions,
      ...browserConfig.contextOptions,
    });
    return { browserContext };
  } catch (error: any) {
    if (error.message.includes("Executable doesn't exist"))
      throw new Error(
        `Browser specified in your config is not installed. Either install it (likely) or change the config.`
      );
    if (error.message.includes('Invalid URL'))
      throw new Error(`Failed to launch persistent context - invalid URL configuration: ${error.message}`);
    throw new Error(`Failed to launch persistent browser context: ${error.message}`);
  }
}

async function createUserDataDir(browserConfig: FullConfig['browser']) {
  let cacheDirectory: string;
  if (process.platform === 'linux') cacheDirectory = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  else if (process.platform === 'darwin') cacheDirectory = path.join(os.homedir(), 'Library', 'Caches');
  else if (process.platform === 'win32')
    cacheDirectory = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  else throw new Error('Unsupported platform: ' + process.platform);

  const result = path.join(
    cacheDirectory,
    'ms-playwright',
    `mcp-${browserConfig.launchOptions?.channel ?? browserConfig?.browserName}-profile`
  );

  try {
    // Check if directory exists and is accessible
    try {
      const stats = await fs.promises.stat(result);
      if (!stats.isDirectory()) {
        // Remove file if it exists but is not a directory
        await fs.promises.unlink(result);
      } else {
        // Check if we can write to the directory
        const testFile = path.join(result, '.write-test');
        try {
          await fs.promises.writeFile(testFile, 'test');
          await fs.promises.unlink(testFile);
        } catch (error) {
          // User data directory is not writable, attempting to clean...
          await fs.promises.rm(result, { recursive: true, force: true });
        }
      }
    } catch (error) {
      // Directory doesn't exist, that's fine
    }

    // Create directory with proper permissions
    await fs.promises.mkdir(result, {
      recursive: true,
      mode: 0o755, // Ensure proper permissions
    });

    return result;
  } catch (error: any) {
    // If we can't create the user data dir, try a temporary one
    // Failed to create user data directory - using temporary one
    const tempDir = path.join(os.tmpdir(), `mcp-${Date.now()}-profile`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    // Using temporary profile directory
    return tempDir;
  }
}
