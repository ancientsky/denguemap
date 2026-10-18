import type { App } from '../app';
import type { Params } from '../lib/router';

export interface ViewContext {
  app: App;
  /** Container the view renders into (cleared between views). */
  root: HTMLElement;
  params: Params;
  /** Write this view's state to the URL query (shareable state). A no-op once a newer navigation has started. */
  setParams(params: Params): void;
}

export interface View {
  /** Same route, new params (back/forward or edited URL). If absent, the view is re-created. */
  update?(params: Params): void;
  destroy(): void;
}

export type ViewFactory = (ctx: ViewContext) => View | Promise<View>;
