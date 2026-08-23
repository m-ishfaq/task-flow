import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadCardAttachment, type UploadCardAttachmentDeps } from './upload-card-attachment.js';

/**
 * Mirrors `upload-message-file.test.ts`'s own approach exactly — see that
 * file's header for why `presign`/`confirm` are stubbed via an injected
 * `deps` object while the PUT is exercised against a stubbed global
 * `fetch`.
 */

function fakeFile(
  overrides: Partial<{ name: string; contentType: string; sizeBytes: number }> = {},
) {
  return {
    name: overrides.name ?? 'spec.pdf',
    contentType: overrides.contentType ?? 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? 2048,
    blob: new Blob(['fake bytes']),
  };
}

function fakeDeps(overrides: Partial<UploadCardAttachmentDeps> = {}): UploadCardAttachmentDeps {
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

describe('uploadCardAttachment', () => {
  it('presigns against the CARD (no messageId), PUTs, then confirms', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
    );
    const deps = fakeDeps();

    const result = await uploadCardAttachment(deps, 'card-1', fakeFile());

    expect(deps.presign).toHaveBeenCalledWith({
      cardId: 'card-1',
      filename: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    });
    expect(deps.confirm).toHaveBeenCalledWith({ attachmentId: 'attachment-1' });
    expect(result).toEqual({ status: 'clean' });
  });

  it('never confirms when storage refuses the PUT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500 })),
    );
    const deps = fakeDeps();

    await expect(uploadCardAttachment(deps, 'card-1', fakeFile())).rejects.toThrow(/500/);
    expect(deps.confirm).not.toHaveBeenCalled();
  });
});
