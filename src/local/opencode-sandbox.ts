import { dirname } from "node:path";

// Agent permissions restrict tools; Seatbelt also blocks symlink/path escapes.
// Infrastructure has a disposable runtime, never the user's HOME/auth/config.
export function openCodeSandboxProfile(worktree: string, runtime: string, binary: string, baseUrl: string, gitMetadata?: string): string {
  const quoted = (value: string) => JSON.stringify(value);
  const readRoots = ["/System", "/usr", "/bin", "/sbin", "/private/etc", "/dev",
    "/Library/Apple", "/opt/homebrew", dirname(dirname(process.execPath)), worktree, runtime,
    ...(gitMetadata ? [gitMetadata] : [])];
  const url = new URL(baseUrl);
  const port = url.port || "80";
  return `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal ${quoted(binary)}) ${readRoots.map(path => `(subpath ${quoted(path)})`).join(" ")})
(allow file-write* (subpath ${quoted(worktree)}) (subpath ${quoted(runtime)}) (literal "/dev/null"))
(deny file-write* (literal ${quoted(`${worktree}/.git`)}))
(allow network-outbound (remote ip "localhost:${port}"))`;
}
