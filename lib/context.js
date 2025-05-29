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
// Testing pre-commit hook functionality
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as playwright from 'playwright';
import { callOnPageNoTrace, waitForCompletion } from './tools/utils.js';
import { ManualPromise } from './manualPromise.js';
import { Tab } from './tab.js';
import { outputFile } from './config.js';
export class Context {
    tools;
    config;
    _browserContextPromise;
    _tabs = [];
    _currentTab;
    _modalStates = [];
    _pendingAction;
    _downloads = [];
    clientVersion;
    _savedState;
    constructor(tools, config) {
        this.tools = tools;
        this.config = config;
    }
    clientSupportsImages() {
        if (this.config.imageResponses === 'allow')
            return true;
        if (this.config.imageResponses === 'omit')
            return false;
        return !this.clientVersion?.name.includes('cursor');
    }
    modalStates() {
        return this._modalStates;
    }
    setModalState(modalState, inTab) {
        this._modalStates.push({ ...modalState, tab: inTab });
    }
    clearModalState(modalState) {
        this._modalStates = this._modalStates.filter(state => state !== modalState);
    }
    modalStatesMarkdown() {
        const result = ['### Modal state'];
        if (this._modalStates.length === 0)
            result.push('- There is no modal state present');
        for (const state of this._modalStates) {
            const tool = this.tools.find(tool => tool.clearsModalState === state.type);
            result.push(`- [${state.description}]: can be handled by the "${tool?.schema.name}" tool`);
        }
        return result;
    }
    tabs() {
        return this._tabs;
    }
    currentTabOrDie() {
        if (!this._currentTab)
            throw new Error('No current snapshot available. Capture a snapshot of navigate to a new location first.');
        return this._currentTab;
    }
    async newTab() {
        const { browserContext } = await this._ensureBrowserContext();
        const page = await browserContext.newPage();
        this._currentTab = this._tabs.find(t => t.page === page);
        return this._currentTab;
    }
    async selectTab(index) {
        this._currentTab = this._tabs[index - 1];
        await this._currentTab.page.bringToFront();
    }
    async ensureTab() {
        const { browserContext } = await this._ensureBrowserContext();
        if (!this._currentTab)
            await browserContext.newPage();
        return this._currentTab;
    }
    async listTabsMarkdown() {
        if (!this._tabs.length)
            return '### No tabs open';
        const lines = ['### Open tabs'];
        for (let i = 0; i < this._tabs.length; i++) {
            const tab = this._tabs[i];
            const title = await tab.title();
            const url = tab.page.url();
            const current = tab === this._currentTab ? ' (current)' : '';
            lines.push(`- ${i + 1}:${current} [${title}] (${url})`);
        }
        return lines.join('\n');
    }
    async closeTab(index) {
        const tab = index === undefined ? this._currentTab : this._tabs[index - 1];
        await tab?.page.close();
        return await this.listTabsMarkdown();
    }
    async run(tool, params) {
        // Tab management is done outside of the action() call.
        const toolResult = await tool.handle(this, tool.schema.inputSchema.parse(params || {}));
        const { code, action, waitForNetwork, captureSnapshot, resultOverride } = toolResult;
        const racingAction = action ? () => this._raceAgainstModalDialogs(action) : undefined;
        if (resultOverride)
            return resultOverride;
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
            const result = [];
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
        let actionResult;
        try {
            if (waitForNetwork)
                actionResult = (await waitForCompletion(this, tab, async () => racingAction?.())) ?? undefined;
            else
                actionResult = (await racingAction?.()) ?? undefined;
        }
        finally {
            if (captureSnapshot && !this._javaScriptBlocked())
                await tab.captureSnapshot();
        }
        const result = [];
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
                else
                    result.push(`- Downloading file ${entry.download.suggestedFilename()} ...`);
            }
            result.push('');
        }
        if (this.tabs().length > 1)
            result.push(await this.listTabsMarkdown(), '');
        if (this.tabs().length > 1)
            result.push('### Current tab');
        result.push(`- Page URL: ${tab.page.url()}`, `- Page Title: ${await tab.title()}`);
        if (captureSnapshot && tab.hasSnapshot())
            result.push(tab.snapshotOrDie().text());
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
    async waitForTimeout(time) {
        if (!this._currentTab || this._javaScriptBlocked()) {
            await new Promise(f => setTimeout(f, time));
            return;
        }
        await callOnPageNoTrace(this._currentTab.page, page => {
            return page.evaluate(() => new Promise(f => setTimeout(f, 1000)));
        });
    }
    async _raceAgainstModalDialogs(action) {
        this._pendingAction = {
            dialogShown: new ManualPromise(),
        };
        let result;
        try {
            await Promise.race([action().then(r => (result = r)), this._pendingAction.dialogShown]);
        }
        finally {
            this._pendingAction = undefined;
        }
        return result;
    }
    _javaScriptBlocked() {
        return this._modalStates.some(state => state.type === 'dialog');
    }
    dialogShown(tab, dialog) {
        this.setModalState({
            type: 'dialog',
            description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,
            dialog,
        }, tab);
        this._pendingAction?.dialogShown.resolve();
    }
    async downloadStarted(tab, download) {
        const entry = {
            download,
            finished: false,
            outputFile: await outputFile(this.config, download.suggestedFilename()),
        };
        this._downloads.push(entry);
        await download.saveAs(entry.outputFile);
        entry.finished = true;
    }
    _onPageCreated(page) {
        const tab = new Tab(this, page, tab => this._onPageClosed(tab));
        this._tabs.push(tab);
        if (!this._currentTab)
            this._currentTab = tab;
    }
    _onPageClosed(tab) {
        this._modalStates = this._modalStates.filter(state => state.tab !== tab);
        const index = this._tabs.indexOf(tab);
        if (index === -1)
            return;
        this._tabs.splice(index, 1);
        if (this._currentTab === tab)
            this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
        if (!this._tabs.length)
            void this.close();
    }
    async close() {
        if (!this._browserContextPromise)
            return;
        const promise = this._browserContextPromise;
        this._browserContextPromise = undefined;
        await promise.then(async ({ browserContext, browser }) => {
            if (this.config.saveTrace)
                await browserContext.tracing.stop();
            await browserContext
                .close()
                .then(async () => {
                await browser?.close();
            })
                .catch(() => { });
        });
    }
    async resetBrowserContext(cleanProfile = false, preserveState = true) {
        let savedState;
        // Capture current state before closing if requested and context exists
        if (preserveState && this._browserContextPromise) {
            try {
                savedState = await this._captureCurrentState();
            }
            catch (error) {
                // Failed to capture state, continuing without it
            }
        }
        // Close current context if it exists
        await this.close();
        // If requested, clean the profile directory to fix corruption issues
        if (cleanProfile &&
            !this.config.browser?.isolated &&
            !this.config.browser?.remoteEndpoint &&
            !this.config.browser?.cdpEndpoint) {
            try {
                const userDataDir = this.config.browser?.userDataDir ??
                    (await createUserDataDir({
                        ...this.config.browser,
                        browserName: this.config.browser?.browserName ?? 'chromium',
                    }));
                // Only clean if it's in the standard cache location (safety check)
                const cacheDirectory = process.platform === 'darwin'
                    ? path.join(os.homedir(), 'Library', 'Caches')
                    : process.platform === 'linux'
                        ? process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
                        : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
                if (userDataDir.startsWith(path.join(cacheDirectory, 'ms-playwright'))) {
                    // Cleaning corrupted profile directory
                    await fs.promises.rm(userDataDir, { recursive: true, force: true });
                }
            }
            catch (error) {
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
        // Store the saved state to restore later
        this._savedState = savedState;
    }
    get browserContextPromise() {
        return this._browserContextPromise;
    }
    get savedState() {
        return this._savedState;
    }
    set savedState(state) {
        this._savedState = state;
    }
    async captureCurrentState() {
        return this._captureCurrentState();
    }
    async _captureCurrentState() {
        try {
            const { browserContext } = await this._browserContextPromise;
            const state = {
                storageState: null,
                sessionStorage: {},
                tabs: [],
                currentTabIndex: 0,
            };
            // Capture storage state (cookies, localStorage, IndexedDB)
            try {
                state.storageState = await browserContext.storageState({
                    indexedDB: true, // Include IndexedDB for modern authentication
                });
            }
            catch (error) {
                // Storage state capture failed, continuing without it
            }
            // Capture session storage and tab information from all tabs
            const tabs = this.tabs();
            if (tabs.length > 0) {
                for (let i = 0; i < tabs.length; i++) {
                    const tab = tabs[i];
                    try {
                        // Get current URL
                        const url = tab.page.url();
                        // Get session storage for this domain
                        const sessionStorage = await tab.page.evaluate(() => {
                            try {
                                return JSON.stringify(sessionStorage);
                            }
                            catch {
                                return '{}';
                            }
                        });
                        state.tabs.push({
                            url,
                            sessionStorage: JSON.parse(sessionStorage),
                        });
                        // Track current tab
                        if (tab === this._currentTab) {
                            state.currentTabIndex = i;
                        }
                    }
                    catch (error) {
                        // Failed to capture tab state, add empty entry
                        state.tabs.push({
                            url: 'about:blank',
                            sessionStorage: {},
                        });
                    }
                }
            }
            return state;
        }
        catch (error) {
            // Failed to capture state
            return undefined;
        }
    }
    async _restoreState(browserContext) {
        if (!this._savedState)
            return;
        try {
            // Restore session storage via init script for all domains
            if (Object.keys(this._savedState.sessionStorage).length > 0) {
                await browserContext.addInitScript((sessionStorageData) => {
                    try {
                        // Restore session storage for current domain
                        const hostname = window.location.hostname;
                        const data = sessionStorageData[hostname];
                        if (data) {
                            Object.keys(data).forEach(key => {
                                window.sessionStorage.setItem(key, data[key]);
                            });
                        }
                    }
                    catch (error) {
                        // Session storage restoration failed
                    }
                }, this._savedState.sessionStorage);
            }
            // Create and navigate tabs to restore previous session
            if (this._savedState.tabs.length > 0) {
                // The first page is automatically created by the context
                const firstTab = this._savedState.tabs[0];
                const existingPages = browserContext.pages();
                if (existingPages.length > 0 && firstTab.url !== 'about:blank') {
                    // Navigate first existing page
                    try {
                        await existingPages[0].goto(firstTab.url);
                        // Restore session storage for this tab
                        await this._restoreSessionStorageForPage(existingPages[0], firstTab.sessionStorage);
                    }
                    catch (error) {
                        // Navigation failed
                    }
                }
                // Create additional tabs
                for (let i = 1; i < this._savedState.tabs.length; i++) {
                    const tabData = this._savedState.tabs[i];
                    try {
                        const page = await browserContext.newPage();
                        if (tabData.url !== 'about:blank') {
                            await page.goto(tabData.url);
                            // Restore session storage for this tab
                            await this._restoreSessionStorageForPage(page, tabData.sessionStorage);
                        }
                    }
                    catch (error) {
                        // Tab creation/navigation failed
                    }
                }
                // Switch to the previously current tab
                if (this._savedState.currentTabIndex >= 0 && this._savedState.currentTabIndex < this._tabs.length) {
                    try {
                        await this.selectTab(this._savedState.currentTabIndex + 1); // selectTab is 1-indexed
                    }
                    catch (error) {
                        // Tab selection failed
                    }
                }
            }
        }
        catch (error) {
            // State restoration failed
        }
        finally {
            // Clear saved state after restoration attempt
            this._savedState = undefined;
        }
    }
    async _restoreSessionStorageForPage(page, sessionStorage) {
        if (Object.keys(sessionStorage).length === 0)
            return;
        try {
            await page.evaluate((storage) => {
                Object.keys(storage).forEach(key => {
                    window.sessionStorage.setItem(key, storage[key]);
                });
            }, sessionStorage);
        }
        catch (error) {
            // Session storage injection failed
        }
    }
    async _setupRequestInterception(context) {
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
    _ensureBrowserContext() {
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
    async _setupBrowserContext() {
        const { browser, browserContext } = await this._createBrowserContext();
        await this._setupRequestInterception(browserContext);
        for (const page of browserContext.pages())
            this._onPageCreated(page);
        browserContext.on('page', page => this._onPageCreated(page));
        // Restore saved state if available
        await this._restoreState(browserContext);
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
    async _createBrowserContext() {
        // Check if we have saved storage state to restore
        // Only use storage state if we explicitly have saved state (from a restart with preserveState: true)
        const storageStateOption = this._savedState?.storageState || this.config.browser?.contextOptions?.storageState;
        if (this.config.browser?.remoteEndpoint) {
            if (typeof this.config.browser.remoteEndpoint !== 'string' || this.config.browser.remoteEndpoint.trim() === '') {
                throw new Error(`Invalid remote endpoint: ${this.config.browser.remoteEndpoint}. Must be a valid URL string.`);
            }
            const url = new URL(this.config.browser.remoteEndpoint);
            if (this.config.browser.browserName)
                url.searchParams.set('browser', this.config.browser.browserName);
            if (this.config.browser.launchOptions)
                url.searchParams.set('launch-options', JSON.stringify(this.config.browser.launchOptions));
            const browser = await playwright[this.config.browser?.browserName ?? 'chromium'].connect(String(url));
            const browserContext = await browser.newContext({
                ...(this.config.browser?.contextOptions || {}),
                storageState: storageStateOption,
            });
            return { browser, browserContext };
        }
        if (this.config.browser?.cdpEndpoint) {
            if (typeof this.config.browser.cdpEndpoint !== 'string' || this.config.browser.cdpEndpoint.trim() === '') {
                throw new Error(`Invalid CDP endpoint: ${this.config.browser.cdpEndpoint}. Must be a valid URL string.`);
            }
            const browser = await playwright.chromium.connectOverCDP(this.config.browser.cdpEndpoint);
            const browserContext = this.config.browser.isolated
                ? await browser.newContext({
                    ...(this.config.browser?.contextOptions || {}),
                    storageState: storageStateOption,
                })
                : browser.contexts()[0];
            return { browser, browserContext };
        }
        return this.config.browser?.isolated
            ? await createIsolatedContext(this.config.browser, storageStateOption)
            : await launchPersistentContext(this.config.browser);
    }
}
async function createIsolatedContext(browserConfig, storageStateOption) {
    try {
        const browserName = browserConfig?.browserName ?? 'chromium';
        const browserType = playwright[browserName];
        const browser = await browserType.launch(browserConfig.launchOptions);
        // Only include storage state if explicitly provided (from preserved state)
        const contextOptions = { ...(browserConfig.contextOptions || {}) };
        if (storageStateOption) {
            contextOptions.storageState = storageStateOption;
        }
        const browserContext = await browser.newContext(contextOptions);
        return { browser, browserContext };
    }
    catch (error) {
        if (error.message.includes("Executable doesn't exist"))
            throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
        throw new Error(`Failed to create isolated browser context: ${error.message}`);
    }
}
async function launchPersistentContext(browserConfig) {
    try {
        const browserName = browserConfig.browserName ?? 'chromium';
        const userDataDir = browserConfig.userDataDir ?? (await createUserDataDir({ ...browserConfig, browserName }));
        const browserType = playwright[browserName];
        const browserContext = await browserType.launchPersistentContext(userDataDir, {
            ...browserConfig.launchOptions,
            ...browserConfig.contextOptions,
        });
        return { browserContext };
    }
    catch (error) {
        if (error.message.includes("Executable doesn't exist"))
            throw new Error(`Browser specified in your config is not installed. Either install it (likely) or change the config.`);
        if (error.message.includes('Invalid URL'))
            throw new Error(`Failed to launch persistent context - invalid URL configuration: ${error.message}`);
        throw new Error(`Failed to launch persistent browser context: ${error.message}`);
    }
}
async function createUserDataDir(browserConfig) {
    // Check for custom user data directory from environment variables
    // Priority: PLAYWRIGHT_USER_DATA_DIR -> MCP_USER_DATA_DIR -> BROWSER_PROFILE_DIR -> default
    const customUserDataDir = process.env.PLAYWRIGHT_USER_DATA_DIR || process.env.MCP_USER_DATA_DIR || process.env.BROWSER_PROFILE_DIR;
    if (customUserDataDir) {
        // Use environment-specified directory
        const resolvedPath = path.resolve(customUserDataDir);
        try {
            await ensureDirectoryExists(resolvedPath);
            return resolvedPath;
        }
        catch (error) {
            // Failed to use custom user data directory, falling back to default
        }
    }
    // Check for browser-specific environment variables
    const browserName = browserConfig?.browserName ?? 'chromium';
    const browserSpecificDir = process.env[`PLAYWRIGHT_${browserName.toUpperCase()}_USER_DATA_DIR`] ||
        process.env[`MCP_${browserName.toUpperCase()}_PROFILE_DIR`];
    if (browserSpecificDir) {
        const resolvedPath = path.resolve(browserSpecificDir);
        try {
            await ensureDirectoryExists(resolvedPath);
            return resolvedPath;
        }
        catch (error) {
            // Failed to use browser-specific user data directory, falling back to default
        }
    }
    // Determine base cache directory with environment variable support
    let cacheDirectory;
    const customCacheBase = process.env.PLAYWRIGHT_BROWSERS_PATH || process.env.MCP_CACHE_DIR;
    if (customCacheBase && customCacheBase !== '0') {
        // Use custom cache directory
        cacheDirectory = path.resolve(customCacheBase);
    }
    else {
        // Use platform-specific default cache directories
        if (process.platform === 'linux')
            cacheDirectory = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
        else if (process.platform === 'darwin')
            cacheDirectory = path.join(os.homedir(), 'Library', 'Caches');
        else if (process.platform === 'win32')
            cacheDirectory = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        else
            throw new Error('Unsupported platform: ' + process.platform);
    }
    // Create profile-specific directory name
    const profileSuffix = process.env.MCP_PROFILE_SUFFIX || '';
    const channelOrBrowser = browserConfig.launchOptions?.channel ?? browserName;
    const profileName = `mcp-${channelOrBrowser}-profile${profileSuffix}`;
    const result = path.join(cacheDirectory, 'ms-playwright', profileName);
    try {
        await ensureDirectoryExists(result);
        return result;
    }
    catch (error) {
        // If we can't create the user data dir, try a temporary one
        const tempDir = path.join(os.tmpdir(), `mcp-${Date.now()}-profile`);
        await fs.promises.mkdir(tempDir, { recursive: true });
        return tempDir;
    }
}
// Helper function to ensure directory exists and is writable
async function ensureDirectoryExists(dirPath) {
    try {
        // Check if directory exists and is accessible
        try {
            const stats = await fs.promises.stat(dirPath);
            if (!stats.isDirectory()) {
                // Remove file if it exists but is not a directory
                await fs.promises.unlink(dirPath);
            }
            else {
                // Check if we can write to the directory
                const testFile = path.join(dirPath, '.write-test');
                try {
                    await fs.promises.writeFile(testFile, 'test');
                    await fs.promises.unlink(testFile);
                    return; // Directory exists and is writable
                }
                catch (error) {
                    // Directory exists but is not writable, try to fix permissions
                    if (process.env.MCP_FIX_PERMISSIONS === 'true') {
                        try {
                            await fs.promises.chmod(dirPath, 0o755);
                            // Test again after permission fix
                            await fs.promises.writeFile(testFile, 'test');
                            await fs.promises.unlink(testFile);
                            return;
                        }
                        catch (permissionError) {
                            // Could not fix permissions, remove and recreate
                            await fs.promises.rm(dirPath, { recursive: true, force: true });
                        }
                    }
                    else {
                        // User data directory is not writable, attempting to clean...
                        await fs.promises.rm(dirPath, { recursive: true, force: true });
                    }
                }
            }
        }
        catch (error) {
            // Directory doesn't exist, that's fine
        }
        // Create directory with proper permissions
        await fs.promises.mkdir(dirPath, {
            recursive: true,
            mode: 0o755, // Ensure proper permissions
        });
        // Verify the directory was created successfully
        const stats = await fs.promises.stat(dirPath);
        if (!stats.isDirectory()) {
            throw new Error('Failed to create directory');
        }
    }
    catch (error) {
        throw new Error(`Cannot create or access directory ${dirPath}: ${error.message}`);
    }
}
