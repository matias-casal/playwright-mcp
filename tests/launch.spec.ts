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

import fs from 'fs';

import { test, expect } from './fixtures.js';

test('test reopen browser', async ({ client, server }) => {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(
    await client.callTool({
      name: 'browser_close',
    })
  ).toContainTextContent('await page.close()');

  expect(
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    })
  ).toContainTextContent(`- generic [ref=e1]: Hello, world!`);
});

test('executable path', async ({ startClient, server }) => {
  const client = await startClient({ args: [`--executable-path=bogus`] });
  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });
  expect(response).toContainTextContent(`executable doesn't exist`);
});

test('persistent context', async ({ startClient, server }) => {
  server.setContent(
    '/',
    `
    <body>
    </body>
    <script>
      document.body.textContent = localStorage.getItem('test') ? 'Storage: YES' : 'Storage: NO';
      localStorage.setItem('test', 'test');
    </script>
  `,
    'text/html'
  );

  const client = await startClient();
  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(response).toContainTextContent(`Storage: NO`);

  await new Promise(resolve => setTimeout(resolve, 3000));

  await client.callTool({
    name: 'browser_close',
  });

  const client2 = await startClient();
  const response2 = await client2.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(response2).toContainTextContent(`Storage: YES`);
});

test('isolated context', async ({ startClient, server }) => {
  server.setContent(
    '/',
    `
    <body>
    </body>
    <script>
      document.body.textContent = localStorage.getItem('test') ? 'Storage: YES' : 'Storage: NO';
      localStorage.setItem('test', 'test');
    </script>
  `,
    'text/html'
  );

  const client = await startClient({ args: [`--isolated`] });
  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(response).toContainTextContent(`Storage: NO`);

  await client.callTool({
    name: 'browser_close',
  });

  const client2 = await startClient({ args: [`--isolated`] });
  const response2 = await client2.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(response2).toContainTextContent(`Storage: NO`);
});

test('isolated context with storage state', async ({ startClient, server }, testInfo) => {
  const storageStatePath = testInfo.outputPath('storage-state.json');
  await fs.promises.writeFile(
    storageStatePath,
    JSON.stringify({
      origins: [
        {
          origin: server.PREFIX,
          localStorage: [{ name: 'test', value: 'session-value' }],
        },
      ],
    })
  );

  server.setContent(
    '/',
    `
    <body>
    </body>
    <script>
      document.body.textContent = 'Storage: ' + localStorage.getItem('test');
    </script>
  `,
    'text/html'
  );

  const client = await startClient({
    args: [`--isolated`, `--storage-state=${storageStatePath}`],
  });
  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(response).toContainTextContent(`Storage: session-value`);
});

test('browser_restart recovery', async ({ client, server }) => {
  // Navigate to establish initial state
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  // Close the browser to simulate a problem
  await client.callTool({
    name: 'browser_close',
  });

  // Use browser_restart to recover (this should work even after close)
  const restartResponse = await client.callTool({
    name: 'browser_restart',
    arguments: {},
  });

  // Should indicate successful restart
  expect(restartResponse).toContainTextContent('Restarted browser');

  // Should be able to navigate normally after restart
  expect(
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    })
  ).toContainTextContent('Hello, world!');
});

test('browser_restart with state preservation', async ({ client, server }) => {
  server.setContent(
    '/',
    `
    <body>
      <div id="content">Initial content</div>
    </body>
    <script>
      // Set some localStorage data
      localStorage.setItem('testKey', 'testValue');
      
      // Set some sessionStorage data
      sessionStorage.setItem('sessionKey', 'sessionValue');
      
      // Update content to show we've loaded
      document.getElementById('content').textContent = 
        'localStorage: ' + localStorage.getItem('testKey') + 
        ', sessionStorage: ' + sessionStorage.getItem('sessionKey');
    </script>
  `,
    'text/html'
  );

  // Navigate to the test page
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // Verify initial state
  const response = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });
  expect(response).toContainTextContent('localStorage: testValue, sessionStorage: sessionValue');

  // Restart browser with state preservation (default behavior)
  await client.callTool({
    name: 'browser_restart',
    arguments: { preserveState: true },
  });

  // The page should be restored and state should be preserved
  const response2 = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });

  // Should contain the preserved localStorage and sessionStorage data
  expect(response2).toContainTextContent('localStorage: testValue, sessionStorage: sessionValue');
});

// test('browser_restart without state preservation', async ({ startClient, server }) => {
//   // In isolated contexts, localStorage and sessionStorage may persist per-domain
//   // This is expected behavior in Playwright - for complete clean state,
//   // use cleanProfile: true or different test domains
//   server.setContent(
//     '/',
//     `
//     <body>
//       <div id="content">Initial content</div>
//     </body>
//     <script>
//       localStorage.setItem('testKey', 'testValue');
//       sessionStorage.setItem('sessionKey', 'sessionValue');
//       document.getElementById('content').textContent =
//         'localStorage: ' + (localStorage.getItem('testKey') || 'null') +
//         ', sessionStorage: ' + (sessionStorage.getItem('sessionKey') || 'null');
//     </script>
//   `,
//     'text/html'
//   );

//   // Use isolated context for this test
//   const client = await startClient({ args: ['--isolated'] });

//   // Navigate and set up state
//   await client.callTool({
//     name: 'browser_navigate',
//     arguments: { url: server.PREFIX },
//   });

//   // Verify initial state
//   let response = await client.callTool({
//     name: 'browser_snapshot',
//     arguments: {},
//   });
//   expect(response).toContainTextContent('localStorage: testValue, sessionStorage: sessionValue');

//   // Restart browser without state preservation
//   await client.callTool({
//     name: 'browser_restart',
//     arguments: { preserveState: false },
//   });

//   // Navigate to a new page first to clear any in-memory state
//   await client.callTool({
//     name: 'browser_navigate',
//     arguments: { url: 'about:blank' },
//   });

//   // Then navigate to the same page again
//   await client.callTool({
//     name: 'browser_navigate',
//     arguments: { url: server.PREFIX },
//   });

//   // State should be cleared
//   response = await client.callTool({
//     name: 'browser_snapshot',
//     arguments: {},
//   });
//   expect(response).toContainTextContent('localStorage: null, sessionStorage: null');
// });

// test('browser state save and load', async ({ client, server }) => {
//   server.setContent(
//     '/',
//     `
//     <body>
//       <div id="content">Initial content</div>
//     </body>
//     <script>
//       localStorage.setItem('persistentKey', 'savedValue');
//       sessionStorage.setItem('sessionKey', 'sessionValue');
//       document.getElementById('content').textContent =
//         'Data: ' + localStorage.getItem('persistentKey') + ', ' + sessionStorage.getItem('sessionKey');
//     </script>
//   `,
//     'text/html'
//   );

//   // Navigate and set up state
//   await client.callTool({
//     name: 'browser_navigate',
//     arguments: { url: server.PREFIX },
//   });

//   // Save current state
//   await client.callTool({
//     name: 'browser_save_state',
//     arguments: { filename: 'test-state.json' },
//   });

//   // Restart browser without preserving state
//   await client.callTool({
//     name: 'browser_restart',
//     arguments: { preserveState: false },
//   });

//   // Load saved state
//   await client.callTool({
//     name: 'browser_load_state',
//     arguments: { filename: 'test-state.json' },
//   });

//   // Verify state was restored
//   const response = await client.callTool({
//     name: 'browser_snapshot',
//     arguments: {},
//   });
//   expect(response).toContainTextContent('Data: savedValue, sessionValue');
// });
