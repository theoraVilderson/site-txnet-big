import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KEY_BYTES, parseKey } from './vault.crypto';

/**
 * The key-encryption key, read from a mounted file (ADR-0026 decision 1,
 * carrying ADR-0022's store forward unchanged).
 *
 * **The file, not an environment variable, is the decision.** Docker Swarm
 * mounts a secret at `/run/secrets/<name>`; an environment variable is visible
 * in `docker inspect`, in a crash dump, in `/proc/<pid>/environ`, and in every
 * child process this service spawns. `VAULT_KEK_FILE` in the environment is a
 * *path*, which is why it is allowed to live there — ADR-0026 rule 6 forbids
 * reading a credential's **value** from the environment, and F-066-g is what
 * makes that refusal mechanical for tenant-owned credentials.
 *
 * `kekId` names which KEK sealed a DEK. It is stored on every `TenantDek` row,
 * so rotating the KEK re-wraps the DEK rows and touches no credential: that is
 * the property envelope encryption is chosen for, and it is why the id is
 * recorded rather than assumed.
 */
@Injectable()
export class KekService implements OnModuleInit {
  private readonly logger = new Logger(KekService.name);

  /** Cached by id, because a KEK file is read once and never changes in place. */
  private readonly keys = new Map<string, Buffer>();

  private currentId: string | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Load the KEK at boot rather than on first use.
   *
   * A missing or malformed key must be a refusal to start, not a 500 on the
   * first tenant that configures a bot token — by then the deployment looks
   * healthy and the failure is someone else's incident. This is the same
   * fail-closed shape `auth-api` already takes on its first locale snapshot.
   *
   * The one exception is a deployment that has not configured a vault at all:
   * `VAULT_KEK_FILE` unset means no credential can be stored, and the service
   * boots. Every vault operation then refuses with the sentence below, which
   * names the fix. Requiring the key unconditionally would stop `auth-service`
   * from starting anywhere it does not yet hold a tenant credential — which is
   * every deployment today, since F-066-i is what starts writing them.
   */
  onModuleInit(): void {
    const path = this.config.get<string>('VAULT_KEK_FILE');
    if (!path) {
      this.logger.warn(
        'VAULT_KEK_FILE is not set: the credential vault is unavailable and ' +
          'every read or write of a tenant credential will be refused. Mount ' +
          'the Swarm secret and point this at it before configuring a tenant.',
      );
      return;
    }
    this.load(path);
  }

  /** Whether a KEK is loaded at all. */
  get available(): boolean {
    return this.currentId !== null;
  }

  /** The id of the KEK new DEKs are wrapped under. */
  get activeKekId(): string {
    return this.require().id;
  }

  /** The KEK new DEKs are wrapped under. */
  activeKey(): Buffer {
    return this.require().key;
  }

  /**
   * The KEK a stored DEK was wrapped under.
   *
   * A row naming a KEK this process does not hold is a deployment error worth
   * its own sentence: it means the secret was replaced without the DEK rows
   * being re-wrapped, and the credentials under it are unreadable until the
   * old file comes back. Silently trying the active key instead would fail as
   * an authentication error and send whoever reads the log looking at the
   * cipher.
   */
  keyFor(kekId: string): Buffer {
    const key = this.keys.get(kekId);
    if (key) return key;
    throw new Error(
      `This service holds no KEK named '${kekId}', but a tenant_dek row was ` +
        `wrapped under it. Restore that secret file, or re-wrap the DEK rows ` +
        `under the current KEK ('${this.currentId ?? 'none loaded'}').`,
    );
  }

  private require(): { id: string; key: Buffer } {
    if (!this.currentId) {
      throw new Error(
        'The credential vault has no key: set VAULT_KEK_FILE to a mounted ' +
          `${KEY_BYTES}-byte secret. It is deliberately a file path and not ` +
          'the key itself — ADR-0026.',
      );
    }
    return { id: this.currentId, key: this.keys.get(this.currentId) as Buffer };
  }

  private load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(
        `Could not read the vault KEK at '${path}': ${(err as Error).message}. ` +
          'In Swarm this is a mounted secret, usually under /run/secrets/.',
      );
    }

    // `parseKey` throws a sentence naming the fix; let it out unchanged.
    const key = parseKey(raw, `The vault KEK at '${path}'`);

    // The filename is the id. It costs no second setting, it is what an
    // operator already chose when naming the Swarm secret, and rotating means
    // mounting a differently-named file — which makes the old id, and so every
    // DEK still wrapped under it, impossible to confuse with the new one.
    const id = basename(path);
    this.keys.set(id, key);
    this.currentId = id;
    this.logger.log(`Credential vault KEK '${id}' loaded.`);
  }
}
