import type { BreadCrumbsApi } from '../shared/types.js';

declare global {
  interface Window {
    breadcrumbs: BreadCrumbsApi;
  }
}

export {};
