export const SELF_CONTAINED_NODE_REQUIRE_BANNER: string;

export function assertSelfContainedNodeBundle(
  bundle: string,
  builtinModuleNames: ReadonlySet<string>,
): void;
