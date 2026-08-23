import type * as ExpoFileSystem from 'expo-file-system';
import type * as ExpoSharing from 'expo-sharing';
import { decodeBase64 } from './base64.js';

/**
 * Saving a page's exported PDF to disk and handing it to the OS share
 * sheet — the native equivalent of `publish-panel.tsx`'s web-only trick
 * (`Blob` + `URL.createObjectURL` + a synthetic `<a download>` click).
 * `docs.pages.exportPdf` (`apps/api/src/docs/router.ts`) returns the whole
 * file as base64 bytes inline in the tRPC response — no URL, no polling —
 * so there is nothing to fetch here, only bytes already in hand to write.
 *
 * ## Both native packages are imported dynamically, inside `savePdfAndShare`
 *
 * The identical rule `ringtone-player.ts`'s own header documents at
 * length, and for the identical reason: `expo-file-system` and
 * `expo-sharing` both call `requireNativeModule(...)` at MODULE TOP LEVEL,
 * which throws synchronously on any build where the native module is not
 * yet linked — a real, confirmed failure mode this session already hit
 * once with a different native dependency (`react-native-get-random-
 * values`, see `webcrypto-shim.ts`'s own header), not a hypothetical one.
 * `docs-page/[pageId].tsx` is reached by navigation, not mounted for every
 * route the way `call-surface.tsx` is — so a top-level import here would
 * not poison the WHOLE app the way `use-call.ts`'s original version did,
 * but it would still make opening a Docs page fail outright on a dev
 * client built before `expo-sharing` was added, for a feature (reading the
 * page) that has nothing to do with PDF export. Deferring both imports to
 * the moment "Export as PDF" is actually pressed keeps that failure
 * scoped to the one action that needs it.
 */

interface NativePdf {
  readonly File: typeof ExpoFileSystem.File;
  readonly Paths: typeof ExpoFileSystem.Paths;
  readonly isAvailableAsync: typeof ExpoSharing.isAvailableAsync;
  readonly shareAsync: typeof ExpoSharing.shareAsync;
}

let native: NativePdf | null = null;

async function getNative(): Promise<NativePdf> {
  if (native !== null) return native;
  const [fileSystem, sharing] = await Promise.all([
    import('expo-file-system'),
    import('expo-sharing'),
  ]);
  native = {
    File: fileSystem.File,
    Paths: fileSystem.Paths,
    isAvailableAsync: sharing.isAvailableAsync,
    shareAsync: sharing.shareAsync,
  };
  return native;
}

/**
 * Writes `contentBase64` to this app's cache directory under `filename`
 * and opens the OS share sheet on it. Overwrites any file left behind by a
 * previous export of the same page — exported PDFs are disposable, always
 * regenerable from `docs.pages.exportPdf`, so nothing is lost by not
 * keeping every past export around.
 *
 * Throws if the device has no share target at all (`isAvailableAsync`
 * false — e.g. an iOS Simulator with no Mail/Files configured); the caller
 * is expected to surface that as an ordinary error, the same as any other
 * mutation failure on this screen.
 */
export async function savePdfAndShare(filename: string, contentBase64: string): Promise<void> {
  const deps = await getNative();

  const file = new deps.File(deps.Paths.cache, filename);
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  file.write(decodeBase64(contentBase64));

  const available = await deps.isAvailableAsync();
  if (!available) {
    throw new Error('Sharing is not available on this device.');
  }
  await deps.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
}
