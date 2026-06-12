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

export interface TabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export const Button: React.FC<{
  variant: 'primary' | 'default' | 'reject';
  onClick: (event: React.MouseEvent) => void;
  children: React.ReactNode;
}> = ({ variant, onClick, children }) => {
  return (
    <button className={`button ${variant}`} onClick={onClick} type="button">
      {children}
    </button>
  );
};

export interface TabItemProps {
  tab: TabInfo;
  onClick?: () => void;
  button?: React.ReactNode;
}

export const TabItem: React.FC<TabItemProps> = ({ tab, onClick, button }) => {
  if (onClick) {
    return (
      // The row is a plain layout container (no handler); the clickable area is
      // a real <button> and the action {button} is a SIBLING. This keeps both
      // controls semantic without nesting <button>s (which is invalid HTML and
      // makes the inner button's clicks ambiguous).
      <div className="tab-item">
        <button className="tab-item-main" onClick={onClick} type="button">
          <img
            alt={
              tab.favIconUrl ? `Favicon for ${tab.title}` : 'Default tab icon'
            }
            className="tab-favicon"
            src={
              tab.favIconUrl ||
              'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23f6f8fa"/></svg>'
            }
          />
          <div className="tab-content">
            <div className="tab-title">{tab.title || 'Untitled'}</div>
            <div className="tab-url">{tab.url}</div>
          </div>
        </button>
        {button}
      </div>
    );
  }

  return (
    <div className="tab-item">
      <img
        alt={tab.favIconUrl ? `Favicon for ${tab.title}` : 'Default tab icon'}
        className="tab-favicon"
        src={
          tab.favIconUrl ||
          'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23f6f8fa"/></svg>'
        }
      />
      <div className="tab-content">
        <div className="tab-title">{tab.title || 'Untitled'}</div>
        <div className="tab-url">{tab.url}</div>
      </div>
      {button}
    </div>
  );
};
