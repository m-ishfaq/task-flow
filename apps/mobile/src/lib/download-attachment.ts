/**
 * Downloads a presigned attachment URL to the app's local cache directory and
 * returns the local `file://` URI for use with expo-sharing or an Image source.
 *
 * expo-file-system is used rather than `fetch` + manual write because
 * `File.downloadFileAsync` streams directly to disk without buffering the
 * whole file in JS memory, which matters for large attachments on constrained
 * devices.
 *
 * The presigned URL expires in 60 s (see `attachment.service.ts`), so the
 * download must start immediately after the presign mutation resolves.
 */

import { File, Paths } from 'expo-file-system';

export async function downloadToCache(url: string, filename: string): Promise<string> {
  // Sanitise the filename so it is safe as a path component while remaining
  // recognisable.  Keep the extension — expo-sharing and iOS use it for MIME
  // inference when a UTI is not supplied.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = new File(Paths.cache, safeName);

  // idempotent: true overwrites an existing cached copy rather than throwing
  // DestinationAlreadyExists, which would happen on a second tap of the same
  // attachment in the same session.
  const downloaded = await File.downloadFileAsync(url, dest, { idempotent: true });
  return downloaded.uri;
}
