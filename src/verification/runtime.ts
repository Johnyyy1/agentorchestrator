import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

// /tmp resolves to /private/tmp on macOS. Never inherit a long caller TMPDIR.
// mkdtemp atomically allocates a private (0700), invocation-owned directory.
export async function createVerifierRuntime() {
  const parent = await realpath("/tmp");
  const path = await realpath(await mkdtemp(join(parent, "jo-v-")));
  const owner = await lstat(path);
  const cleanup = async () => {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev ||
        current.ino !== owner.ino || current.uid !== owner.uid || await realpath(path) !== path) {
      throw new Error("Verifier runtime ownership changed; refusing cleanup.");
    }
    await rm(path, { recursive: true, force: false });
  };
  // Reserve space for tsx-<uid>/<pid>.pipe, below macOS's 104-byte sun_path.
  if (Buffer.byteLength(path) > 40) {
    await cleanup();
    throw new Error("Verifier runtime path exceeds its socket path budget.");
  }
  return { path, cleanup };
}
