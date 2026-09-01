import { describe, expect, it, vi } from 'vitest';
import { uploadMessageFile, type UploadMessageFileDeps } from './upload-message-file.js';

/**
 * The presign/PUT/confirm orchestration — all three are stubbed via the
 * injected `deps` object, including `put` (the XHR-backed PUT replaced
 * fetch precisely so this file needs no `vi.stubGlobal('fetch', ...)`).
 * The property under test is call order and what gets sent, not a real
 * network.
 */

function fakeFile(
  overrides: Partial<{ name: string; contentType: string; sizeBytes: number }> = {},
) {
  return {
    name: overrides.name ?? 'report.pdf',
    contentType: overrides.contentType ?? 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? 1024,
    blob: new Blob(['fake bytes']),
  };
}

function fakeDeps(overrides: Partial<UploadMessageFileDeps> = {}): UploadMessageFileDeps {
  return {
    presign: vi.fn().mockResolvedValue({
      attachmentId: 'attachment-1',
      url: 'https://storage.test/upload',
      headers: { 'content-type': 'application/pdf', 'content-length': '1024' },
    }),
    confirm: vi.fn().mockResolvedValue({ status: 'clean' }),
    put: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('uploadMessageFile', () => {
  it('presigns, PUTs the blob with the signed headers verbatim, then confirms', async () => {
    const deps = fakeDeps();
    const stages: string[] = [];

    const result = await uploadMessageFile(deps, 'message-1', fakeFile(), (stage) => {
      stages.push(stage);
    });

    expect(deps.presign).toHaveBeenCalledWith({
      messageId: 'message-1',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });
    expect(deps.put).toHaveBeenCalledWith(
      'https://storage.test/upload',
      { 'content-type': 'application/pdf', 'content-length': '1024' },
      expect.any(Blob),
    );
    expect(deps.confirm).toHaveBeenCalledWith({ attachmentId: 'attachment-1' });
    expect(result).toEqual({ status: 'clean' });
    expect(stages).toEqual(['Requesting an upload URL…', 'Uploading…', 'Scanning…']);
  });

  it('never confirms when storage refuses the PUT', async () => {
    const deps = fakeDeps({
      put: vi.fn().mockRejectedValue(new Error('Storage refused the upload (403).')),
    });

    await expect(uploadMessageFile(deps, 'message-1', fakeFile())).rejects.toThrow(/403/);
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('surfaces a non-clean verdict from confirm without throwing', async () => {
    const deps = fakeDeps({
      confirm: vi.fn().mockResolvedValue({ status: 'infected', reason: 'malware detected' }),
    });

    const result = await uploadMessageFile(deps, 'message-1', fakeFile());

    expect(result).toEqual({ status: 'infected', reason: 'malware detected' });
  });
});
