import type { ClipforgeApi } from "./shared/contracts";

declare global {
  interface Window {
    clipforge: ClipforgeApi;
  }
}

export {};
