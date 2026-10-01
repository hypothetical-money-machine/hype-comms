export class NonTestDatabaseError extends Error {}
export function assertTestDatabaseName(name: string): void;
export function requireTestDatabaseUrl(environment: Record<string, string | undefined>): string;
