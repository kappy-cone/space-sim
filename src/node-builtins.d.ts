// Minimal ambient typings for the node builtins the TEST files use — the
// project deliberately carries no @types/node (zero runtime dependencies;
// tests run under vitest's node runtime, so the implementations are real
// and only tsc needs these declarations).

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}

declare const process: { env: Record<string, string | undefined> };
