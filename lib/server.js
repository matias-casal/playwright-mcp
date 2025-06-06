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
import { createConnection } from './connection.js';
export class Server {
    config;
    _connectionList = [];
    constructor(config) {
        this.config = config;
    }
    async createConnection(transport) {
        const connection = createConnection(this.config);
        this._connectionList.push(connection);
        await connection.server.connect(transport);
        return connection;
    }
    setupExitWatchdog() {
        const handleExit = async () => {
            setTimeout(() => process.exit(0), 15000);
            await Promise.all(this._connectionList.map(connection => connection.close()));
            process.exit(0);
        };
        process.stdin.on('close', handleExit);
        process.on('SIGINT', handleExit);
        process.on('SIGTERM', handleExit);
    }
}
