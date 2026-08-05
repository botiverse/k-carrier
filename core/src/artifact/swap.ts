/**
 * L0 byte swap — delegates the OS-shaped sequence to the platform seam and
 * keeps the artifact layer's typed-error contract.
 *
 * The seam decides HOW bytes get replaced (POSIX rename vs the Windows
 * move-the-running-image dance); this layer guarantees that a failure is a
 * typed SWAP_FAILED rather than a raw errno leaking to callers.
 */
import { platformOpsFor } from "../platform/index.ts";
import { ArtifactError } from "./errors.ts";

export async function atomicWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  try {
    await platformOpsFor().swapExecutable(filePath, data);
  } catch (err) {
    throw new ArtifactError(
      "SWAP_FAILED",
      `could not replace ${filePath}: ${(err as Error).message}`,
    );
  }
}
