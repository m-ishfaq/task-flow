import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadMessageFile, type UploadMessageFileDeps } from './upload-message-file.js';

/**
 * The presign/PUT/confirm orchestration — `presign`/`confirm` are stubbed
 * via an injected `deps` object, and the PUT itself is exercised against a
 * stubbed global `fetch`, mirroring `apps/api/src/platform/
 * push-provider.test.ts`'s own `vi.stubGlobal('fetch', ...)` approach for
 * the identical reason: the property under test is the CALL ORDER and what
 * gets sent, not a real network.
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
      headers: { 'content-type': 'application/pdf' },
    }),
    confirm: vi.fn().mockResolvedValue({ status: 'clean' }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadMessageFile', () => {
  it('presigns, PUTs the blob with the signed headers verbatim, then confirms', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        capturedInit = init;
        return Promise.resolve({ ok: true, status: 200 });
      }),
    );
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
    expect(capturedInit?.method).toBe('PUT');
    expect(capturedInit?.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(deps.confirm).toHaveBeenCalledWith({ attachmentId: 'attachment-1' });
    expect(result).toEqual({ status: 'clean' });
    expect(stages).toEqual(['Requesting an upload URL…', 'Uploading…', 'Scanning…']);
  });

  it('never confirms when storage refuses the PUT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 403 })),
    );
    const deps = fakeDeps();

    await expect(uploadMessageFile(deps, 'message-1', fakeFile())).rejects.toThrow(/403/);
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('surfaces a non-clean verdict from confirm without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    );
    const deps = fakeDeps({
      confirm: vi.fn().mockResolvedValue({ status: 'infected', reason: 'malware detected' }),
    });

    const result = await uploadMessageFile(deps, 'message-1', fakeFile());

    expect(result).toEqual({ status: 'infected', reason: 'malware detected' });
  });
});
