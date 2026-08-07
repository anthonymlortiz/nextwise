import { BackupConflictError, type FileStore, type StoredFile } from './github';

/**
 * An in-memory stand-in for the one file in a GitHub repository.
 *
 * It models the parts of the contents API the sync actually leans on: a file
 * that may not exist yet, a blob sha that changes on every write, and the
 * rejection of a write whose sha is stale. That last one is what makes a
 * two-device race testable without two browsers.
 */
export class FakeGitHubFile implements FileStore {
  text: string | null = null;
  sha = '';
  calls = { read: 0, write: 0, rejected: 0 };
  /** Set to make the next write lose the race, as another device would. */
  interpose: (() => void) | null = null;

  private revision = 0;

  constructor(initial?: string) {
    if (initial !== undefined) this.set(initial);
  }

  /** Writes directly, as if another device had done it. */
  set(text: string): void {
    this.text = text;
    this.sha = `sha-${++this.revision}`;
  }

  async read(): Promise<StoredFile | null> {
    this.calls.read++;
    if (this.text === null) return null;
    return { text: this.text, sha: this.sha };
  }

  async write(text: string, sha: string | null, _message: string): Promise<StoredFile> {
    this.calls.write++;
    if (this.interpose) {
      const run = this.interpose;
      this.interpose = null;
      run();
    }
    const expected = this.text === null ? null : this.sha;
    if (sha !== expected) {
      this.calls.rejected++;
      throw new BackupConflictError('The file changed while this was saving.');
    }
    this.set(text);
    return { text, sha: this.sha };
  }
}
