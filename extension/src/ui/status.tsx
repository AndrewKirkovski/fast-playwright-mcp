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

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TabInfo } from './tab-item.js';
import { Button, TabItem } from './tab-item.js';

interface ConnectionStatus {
  isConnected: boolean;
  connectedTabId: number | null;
  connectedTab?: TabInfo;
}

const StatusApp: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>({
    isConnected: false,
    connectedTabId: null,
  });

  const loadStatus = useCallback(async () => {
    // Get current connection status from the background service worker.
    let response: { connectedTabId?: number | null } | undefined;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'getConnectionStatus',
      });
    } catch {
      // Service worker asleep/unreachable — treat as disconnected.
      setStatus({ isConnected: false, connectedTabId: null });
      return;
    }
    const connectedTabId = response?.connectedTabId ?? null;
    if (!connectedTabId) {
      setStatus({ isConnected: false, connectedTabId: null });
      return;
    }
    // The connected tab may have been closed since the badge was set; if we
    // can't read it, report disconnected rather than throwing.
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(connectedTabId);
    } catch {
      setStatus({ isConnected: false, connectedTabId: null });
      return;
    }
    setStatus({
      isConnected: true,
      connectedTabId,
      connectedTab: {
        id: tab.id ?? 0,
        windowId: tab.windowId ?? 0,
        title: tab.title ?? 'Untitled',
        url: tab.url ?? '',
        favIconUrl: tab.favIconUrl,
      },
    });
  }, []);

  useEffect(() => {
    loadStatus().catch(() => {
      // Errors are handled within the function
    });
  }, [loadStatus]);

  const openConnectedTab = async () => {
    if (!status.connectedTabId) {
      return;
    }
    try {
      await chrome.tabs.update(status.connectedTabId, { active: true });
    } finally {
      window.close();
    }
  };

  const disconnect = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'disconnect' });
    } finally {
      window.close();
    }
  };

  return (
    <div className="app-container">
      <div className="content-wrapper">
        {status.isConnected && status.connectedTab ? (
          <div>
            <div className="tab-section-title">
              Page with connected MCP client:
            </div>
            <div>
              <TabItem
                button={
                  <Button onClick={disconnect} variant="primary">
                    Disconnect
                  </Button>
                }
                onClick={openConnectedTab}
                tab={status.connectedTab}
              />
            </div>
          </div>
        ) : (
          <div className="status-banner">
            No MCP clients are currently connected.
          </div>
        )}
      </div>
    </div>
  );
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<StatusApp />);
}
