import { getServiceStatus, registerRcpServices } from './service.js';

export function activate(): void {
  registerRcpServices();
}

export function deactivate(): void {
  // Read-only service extension: nothing persisted to clean up.
}

export function showStatus(): void {
  registerRcpServices();
  const status = getServiceStatus();
  eda.sys_Dialog.showInformationMessage(
    `Return-Current-Path Checker (MCP) v${status.version}\nRegistered at ${status.registeredAt}\n\n${status.topics.join('\n')}`,
    'Return-Current-Path Checker (MCP)',
  );
}

// EasyEDA Pro looks up headerMenus[*].menuItems[*].registerFn on globalThis as well as on the IIFE export.
(globalThis as unknown as Record<string, unknown>).showStatus = showStatus;
