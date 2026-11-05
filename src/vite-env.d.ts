/// <reference types="vite/client" />

import type { PowerPointBridgeAPI } from './types/poll';

declare global {
  const __LOCAL_LAN_IP__: string | null;

  interface Window {
    powerpointBridge?: PowerPointBridgeAPI;
  }
}
