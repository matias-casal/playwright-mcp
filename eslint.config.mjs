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

import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import notice from 'eslint-plugin-notice';
import path from 'path';
import { fileURLToPath } from 'url';
import stylistic from '@stylistic/eslint-plugin';
import importRules from 'eslint-plugin-import';
import eslintConfigPrettier from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const plugins = {
  '@stylistic': stylistic,
  '@typescript-eslint': typescriptEslint,
  notice,
  'import': importRules,
  'prettier': prettierPlugin,
};

export const baseRules = {
  'import/extensions': ['error', 'ignorePackages', { ts: 'always' }],
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-unused-vars': [2, { args: 'none', caughtErrors: 'none' }],

  // Prettier integration
  'prettier/prettier': 'error',

  /**
   * Enforced rules (non-formatting)
   */
  'eqeqeq': [2],
  'accessor-pairs': [
    2,
    {
      getWithoutSet: false,
      setWithoutGet: false,
    },
  ],
  'curly': [2, 'multi-or-nest', 'consistent'],
  'prefer-const': 2,

  // anti-patterns
  'no-var': 2,
  'no-with': 2,
  'no-multi-str': 2,
  'no-caller': 2,
  'no-implied-eval': 2,
  'no-labels': 2,
  'no-new-object': 2,
  'no-octal-escape': 2,
  'no-self-compare': 2,
  'no-shadow-restricted-names': 2,
  'no-cond-assign': 2,
  'no-debugger': 2,
  'no-dupe-keys': 2,
  'no-duplicate-case': 2,
  'no-empty-character-class': 2,
  'no-unreachable': 2,
  'no-unsafe-negation': 2,
  'radix': 2,
  'valid-typeof': 2,
  'no-implicit-globals': [2],
  'no-unused-expressions': [2, { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }],
  'no-proto': 2,

  // es2015 features
  'require-yield': 2,

  // copyright
  'notice/notice': [
    2,
    {
      mustMatch: 'Copyright',
      templateFile: path.join(__dirname, 'utils', 'copyright.js'),
    },
  ],

  // react
  'react/react-in-jsx-scope': 0,
  'no-console': 2,
};

const languageOptions = {
  parser: tsParser,
  ecmaVersion: 9,
  sourceType: 'module',
  parserOptions: {
    project: path.join(fileURLToPath(import.meta.url), '..', 'tsconfig.all.json'),
  },
};

export default [
  {
    ignores: ['**/*.js'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins,
    languageOptions,
    rules: {
      ...baseRules,
      ...eslintConfigPrettier.rules,
    },
  },
];
