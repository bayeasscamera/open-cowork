/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` — short git SHA of the built revision. */
declare const __BUILD_SHA__: string;
/** Injected by vite.config.ts `define` — ISO timestamp of the build. */
declare const __BUILD_TIME__: string;

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
