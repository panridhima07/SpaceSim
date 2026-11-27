// What this web build is. Both values are stamped in by vite.config.ts.
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;

/** Version of this web build, from package.json. */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** UTC build time as YYYYMMDDHHmmss; '' in dev and in tests. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
