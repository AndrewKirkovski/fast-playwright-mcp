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

type StatusType = 'connected' | 'error' | 'connecting';

function validateRelayUrl(
  relayUrl: string
): { valid: true } | { valid: false; error: string } {
  try {
    const host = new URL(relayUrl).hostname;
    if (host !== '127.0.0.1' && host !== '::1') {
      return {
        valid: false,
        error: `MCP extension only allows loopback connections (127.0.0.1 or ::1). Received host: ${host}`,
      };
    }
    return { valid: true };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return {
      valid: false,
      error: `Invalid mcpRelayUrl parameter in URL: ${relayUrl}. ${errorMessage}`,
    };
  }
}

const ConnectApp: React.FC = () => {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [status, setStatus] = useState<{
    type: StatusType;
    message: string;
  } | null>(null);
  const [showButtons, setShowButtons] = useState(true);
  const [showTabList, setShowTabList] = useState(true);
  const [clientInfo, setClientInfo] = useState('unknown');
  const [mcpRelayUrl, setMcpRelayUrl] = useState('');

  const connectToMCPRelay = useCallback(async (relayUrlParam: string) => {
    let response: { success?: boolean; error?: string } | undefined;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'connectToMCPRelay',
        mcpRelayUrl: relayUrlParam,
      });
    } catch (e) {
      setStatus({
        type: 'error',
        message: `Failed to reach the extension service worker: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (!response?.success) {
      setStatus({
        type: 'error',
        message: `Failed to connect to MCP relay: ${response?.error ?? 'no response'}`,
      });
    }
  }, []);

  const loadTabs = useCallback(async () => {
    let response:
      | { success?: boolean; tabs?: TabInfo[]; error?: string }
      | undefined;
    try {
      response = await chrome.runtime.sendMessage({ type: 'getTabs' });
    } catch (e) {
      setStatus({
        type: 'error',
        message: `Failed to load tabs: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (response?.success && response.tabs) {
      setTabs(response.tabs.filter((tab) => typeof tab.id === 'number'));
    } else {
      setStatus({
        type: 'error',
        message: `Failed to load tabs: ${response?.error ?? 'no response'}`,
      });
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const relayUrl = params.get('mcpRelayUrl');

    if (!relayUrl) {
      setShowButtons(false);
      setStatus({
        type: 'error',
        message: 'Missing mcpRelayUrl parameter in URL.',
      });
      return;
    }

    const validation = validateRelayUrl(relayUrl);
    if (!validation.valid) {
      setStatus({ type: 'error', message: validation.error });
      setShowButtons(false);
      return;
    }

    setMcpRelayUrl(relayUrl);

    try {
      const client = JSON.parse(params.get('client') || '{}');
      const info =
        client && typeof client === 'object' && client.name
          ? `${client.name}/${client.version ?? '?'}`
          : 'unknown client';
      setClientInfo(info);
      setStatus({
        type: 'connecting',
        message: `🎭 Playwright MCP started from  "${info}" is trying to connect. Do you want to continue?`,
      });
    } catch (error: unknown) {
      // Error details are captured in the status message for user visibility
      setStatus({
        type: 'error',
        message: `Failed to parse client version${error instanceof Error ? `: ${error.message}` : '.'}`,
      });
      return;
    }

    connectToMCPRelay(relayUrl).catch(() => {
      // Errors are handled within the function
    });
    loadTabs().catch(() => {
      // Errors are handled within the function
    });
  }, [connectToMCPRelay, loadTabs]);

  const handleConnectToTab = useCallback(
    async (tab: TabInfo) => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'connectToTab',
          mcpRelayUrl,
          tabId: tab.id,
          windowId: tab.windowId,
        });

        if (response?.success) {
          // Only hide the picker once the tab is actually connected.
          setShowButtons(false);
          setShowTabList(false);
          setStatus({
            type: 'connected',
            message: `MCP client "${clientInfo}" connected.`,
          });
        } else {
          // Leave the picker visible so the user can retry another tab.
          setStatus({
            type: 'error',
            message:
              response?.error ||
              `MCP client "${clientInfo}" failed to connect.`,
          });
        }
      } catch (e) {
        setStatus({
          type: 'error',
          message: `MCP client "${clientInfo}" failed to connect: ${e}`,
        });
      }
    },
    [clientInfo, mcpRelayUrl]
  );

  const handleReject = useCallback(() => {
    setShowButtons(false);
    setShowTabList(false);
    setStatus({
      type: 'error',
      message: 'Connection rejected. This tab can be closed.',
    });
  }, []);

  useEffect(() => {
    const listener = (message: { type?: string }) => {
      if (message.type === 'connectionTimeout') {
        handleReject();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [handleReject]);

  return (
    <div className="app-container">
      <div className="content-wrapper">
        {status && (
          <div className="status-container">
            <StatusBanner message={status.message} type={status.type} />
            {showButtons && (
              <Button onClick={handleReject} variant="reject">
                Reject
              </Button>
            )}
          </div>
        )}

        {showTabList && (
          <div>
            <div className="tab-section-title">
              Select page to expose to MCP server:
            </div>
            <div>
              {tabs.map((tab) => (
                <TabItem
                  button={
                    <Button
                      onClick={() => handleConnectToTab(tab)}
                      variant="primary"
                    >
                      Connect
                    </Button>
                  }
                  key={tab.id}
                  tab={tab}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const StatusBanner: React.FC<{ type: StatusType; message: string }> = ({
  type,
  message,
}) => {
  return <div className={`status-banner ${type}`}>{message}</div>;
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<ConnectApp />);
}
