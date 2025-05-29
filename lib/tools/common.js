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
import { z } from 'zod';
import { defineTool } from './tool.js';
const close = defineTool({
    capability: 'core',
    schema: {
        name: 'browser_close',
        title: 'Close browser',
        description: 'Close the page',
        inputSchema: z.object({}),
        type: 'readOnly',
    },
    handle: async (context) => {
        await context.close();
        return {
            code: [`await page.close()`],
            captureSnapshot: false,
            waitForNetwork: false,
        };
    },
});
const restart = defineTool({
    capability: 'core',
    schema: {
        name: 'browser_restart',
        title: 'Restart browser',
        description: 'Restart the browser and reset all state. Use this when the browser is in an inconsistent state or experiencing connection issues.',
        inputSchema: z.object({
            cleanProfile: z
                .boolean()
                .optional()
                .describe('Clean the browser profile directory to fix corruption issues. Use with caution as this will clear all browser data including cookies and saved logins.'),
            preserveState: z
                .boolean()
                .optional()
                .default(true)
                .describe('Preserve the current browser session state (cookies, localStorage, sessionStorage, tabs, and current page) across the restart. Set to false to start with a completely clean state.'),
        }),
        type: 'readOnly',
    },
    handle: async (context, params) => {
        try {
            await context.resetBrowserContext(params.cleanProfile, params.preserveState);
            const cleanMsg = params.cleanProfile ? ' and cleaned profile directory' : '';
            const stateMsg = params.preserveState ? ' with preserved session state' : ' with clean state';
            return {
                code: [`// Restarted browser${cleanMsg}${stateMsg} and reset all internal state`],
                captureSnapshot: false,
                waitForNetwork: false,
            };
        }
        catch (error) {
            // Error during browser restart
            return {
                code: [`// Error restarting browser: ${error.message}`],
                captureSnapshot: false,
                waitForNetwork: false,
            };
        }
    },
});
const resize = captureSnapshot => defineTool({
    capability: 'core',
    schema: {
        name: 'browser_resize',
        title: 'Resize browser window',
        description: 'Resize the browser window',
        inputSchema: z.object({
            width: z.number().describe('Width of the browser window'),
            height: z.number().describe('Height of the browser window'),
        }),
        type: 'readOnly',
    },
    handle: async (context, params) => {
        const tab = context.currentTabOrDie();
        const code = [
            `// Resize browser window to ${params.width}x${params.height}`,
            `await page.setViewportSize({ width: ${params.width}, height: ${params.height} });`,
        ];
        const action = async () => {
            await tab.page.setViewportSize({
                width: params.width,
                height: params.height,
            });
        };
        return {
            code,
            action,
            captureSnapshot,
            waitForNetwork: true,
        };
    },
});
const saveState = defineTool({
    capability: 'core',
    schema: {
        name: 'browser_save_state',
        title: 'Save browser state',
        description: 'Save the current browser session state (cookies, localStorage, sessionStorage, tabs, and current page) to a file for later restoration.',
        inputSchema: z.object({
            filename: z
                .string()
                .optional()
                .describe('Filename to save the state to. If not provided, a default filename with timestamp will be used.'),
        }),
        type: 'readOnly',
    },
    handle: async (context, params) => {
        try {
            if (!context.browserContextPromise) {
                return {
                    code: [`// No browser context available to save state from`],
                    captureSnapshot: false,
                    waitForNetwork: false,
                };
            }
            const savedState = await context.captureCurrentState();
            if (!savedState) {
                return {
                    code: [`// Failed to capture browser state`],
                    captureSnapshot: false,
                    waitForNetwork: false,
                };
            }
            const filename = params.filename || `browser-state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            const fs = await import('fs');
            await fs.promises.writeFile(filename, JSON.stringify(savedState, null, 2));
            return {
                code: [`// Saved browser state to ${filename}`],
                captureSnapshot: false,
                waitForNetwork: false,
            };
        }
        catch (error) {
            return {
                code: [`// Error saving browser state: ${error.message}`],
                captureSnapshot: false,
                waitForNetwork: false,
            };
        }
    },
});
const loadState = defineTool({
    capability: 'core',
    schema: {
        name: 'browser_load_state',
        title: 'Load browser state',
        description: 'Load a previously saved browser session state from a file and restore it to the current browser context.',
        inputSchema: z.object({
            filename: z.string().describe('Filename to load the state from.'),
            restart: z
                .boolean()
                .optional()
                .default(true)
                .describe('Whether to restart the browser before loading the state. Recommended to ensure clean restoration.'),
        }),
        type: 'readOnly',
    },
    handle: async (context, params) => {
        try {
            const fs = await import('fs');
            // Check if file exists
            try {
                await fs.promises.access(params.filename);
            }
            catch {
                return {
                    code: [`// State file '${params.filename}' not found`],
                    captureSnapshot: false,
                    waitForNetwork: false,
                };
            }
            // Read and parse state file
            const stateData = await fs.promises.readFile(params.filename, 'utf-8');
            const savedState = JSON.parse(stateData);
            // Store the state for restoration
            context.savedState = savedState;
            if (params.restart) {
                // Restart browser context to apply the loaded state
                await context.resetBrowserContext(false, false); // Don't preserve current state, don't clean profile
                return {
                    code: [`// Loaded and applied browser state from ${params.filename}`],
                    captureSnapshot: false,
                    waitForNetwork: false,
                };
            }
            else {
                return {
                    code: [`// Loaded browser state from ${params.filename}. Use browser_restart to apply it.`],
                    captureSnapshot: false,
                    waitForNetwork: false,
                };
            }
        }
        catch (error) {
            return {
                code: [`// Error loading browser state: ${error.message}`],
                captureSnapshot: false,
                waitForNetwork: false,
            };
        }
    },
});
export const tools = [close, restart, resize(true), saveState, loadState];
export default (captureSnapshot) => [close, restart, resize(captureSnapshot), saveState, loadState];
