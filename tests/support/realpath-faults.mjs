// Realpath() faults the kernel will not hand a test (idb-vector-xi96).
//
// tools/wiki-demo-server.mjs confinedFile() and tools/research-asset-allowlist.mjs acceptanceAsset()
// answer null only for ENOENT and ENOTDIR and rethrow every other realpath() fault, so two rows of that
// set matter: "the filesystem failed to answer" (a 500, tools/server-fault.mjs) and "there is no such
// name" (the shared refusal, tools/refusal.mjs). Two of the three fault errnos come out of a real tree
// in /tmp - ELOOP from a symlink that points at itself, EACCES from a directory the process cannot
// traverse - but EIO does not: no permission bit, link or directory layout makes readlink() fail with
// EIO. That code comes from a failing device or network filesystem, and nothing this repo's test
// toolchain can build produces one. A fault pin written only over the errnos a tree happens to produce
// is the hole this bead records (EACCES back on the null path stayed green), so the EIO row is induced
// by standing in for the syscall instead of pretending the tree can fail that way.
//
// HOW: fs.promises.realpath is replaced with a wrapper that throws a chosen errno for the paths the
// caller names and delegates every other call to the real function, and syncBuiltinESMExports()
// republishes it - the same mechanism tests/support/fast-tier-guard.mjs uses to make its patched
// builtins visible to named, default and dynamic imports alike. Production cannot see through the stub:
// `import { realpath } from 'node:fs/promises'` is bound to the wrapper, the thrown object has the
// shape Node's own errors have ({ code, syscall, path }), and confinedFile()/acceptanceAsset() run their
// absent()-or-rethrow decision on it unchanged. Nothing in the two helpers is stubbed, only the call
// they make.
//
// The patch is process-global while it is installed, so it is installed inside the test that needs it
// and removed in that test's t.after(); the caller passes one marker path per induced errno.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// faults: [absolutePath, errno] pairs. A realpath() of exactly that path throws that errno; every other
// path, including every other call the same test makes, reaches the real implementation.
export function simulateRealpathFaults(faults) {
  const errnoByPath = new Map(faults);
  const realpath = fs.promises.realpath;
  fs.promises.realpath = async function faultedRealpath(target, ...rest) {
    const errno = errnoByPath.get(String(target));
    if (errno !== undefined) {
      throw Object.assign(
        new Error(`simulated ${errno} for ${target} (idb-vector-xi96)`),
        { code: errno, syscall: 'realpath', path: String(target) },
      );
    }
    return realpath(target, ...rest);
  };
  syncBuiltinESMExports();
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      fs.promises.realpath = realpath;
      syncBuiltinESMExports();
    },
  };
}
