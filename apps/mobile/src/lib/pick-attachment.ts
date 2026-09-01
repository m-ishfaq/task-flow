import type * as DocumentPicker from 'expo-document-picker';
import { ACCEPTED_ATTACHMENT_TYPES } from './accepted-file-types.js';
import type { PickedFile } from './upload-message-file.js';

/**
 * Turns a device file pick into the `PickedFile` shape
 * `upload-message-file.ts` consumes. `expo-document-picker` is loaded
 * lazily, never as a static top-level import — the SIXTH time this exact
 * bug shape has been named in this codebase (`device-key.ts`,
 * `biometric-gate.native.ts`, `passkeys.ts`, `qr-code.tsx`,
 * `push-notifications.ts`): a native module's entry file commonly calls
 * `requireNativeModule` at ITS top level, which throws wherever the module
 * is not yet linked, and a static import in a file reachable from the root
 * layout would poison Metro's whole module graph before a single screen
 * renders.
 *
 * **`sizeBytes` comes from the fetched `Blob`, not `DocumentPickerAsset.
 * size`.** The asset's own `size` field is `undefined` on some Android
 * content providers, and even where present it is metadata the OS reports
 * rather than the byte count this device is about to send — `presign`'s
 * `sizeBytes` PINS the upload signature (`packages/storage`'s `signable
 * Headers`), so what gets declared must be exactly what gets PUT, not a
 * value that merely usually agrees with it. Reading the file into a `Blob`
 * here (`fetch(uri).then(r => r.blob())`, the standard React Native idiom
 * for turning a local file URI into upload-able bytes) makes `blob.size`
 * the same object `uploadMessageFile` later sends as the PUT body, so the
 * two can never disagree.
 */
export async function pickAttachment(): Promise<PickedFile | null> {
  let picker: typeof DocumentPicker;
  try {
    picker = await import('expo-document-picker');
  } catch {
    throw new Error('File picker is not available on this device.');
  }

  const result = await picker.getDocumentAsync({
    type: ACCEPTED_ATTACHMENT_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (asset === undefined) return null;

  const response = await fetch(asset.uri);
  const blob = await response.blob();

  return {
    name: asset.name,
    contentType: asset.mimeType ?? 'application/octet-stream',
    sizeBytes: blob.size,
    blob,
  };
}
