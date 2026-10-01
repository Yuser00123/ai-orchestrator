import type { AuthIdentity, StorePort } from '../contracts/index.js';
import { AuthError } from '../core/errors.js';
import { constantTimeEqualHex, newToken, sha256Hex } from '../core/util.js';

/**
 * Bearer API keys for the frontend (§9-1). Frontend NEVER sees the gateway key.
 * Master key (env) has admin powers; issued keys are per-client, stored hashed.
 */
export class KeyAuth {
  private readonly masterHash: string | null;

  constructor(
    private readonly store: StorePort,
    masterKey: string | undefined,
  ) {
    this.masterHash = masterKey ? sha256Hex(masterKey) : null;
  }

  async authenticate(headerValue: string | undefined): Promise<AuthIdentity> {
    const token = headerValue?.startsWith('Bearer ') ? headerValue.slice(7).trim() : undefined;
    if (!token) throw new AuthError();
    const hash = sha256Hex(token);

    if (this.masterHash && constantTimeEqualHex(hash, this.masterHash)) {
      return { userId: 'master', profile: 'power', admin: true };
    }
    const row = await this.store.lookupApiKey(hash);
    if (!row || row.revoked) throw new AuthError();
    return { userId: row.userId, profile: row.profile, admin: false };
  }

  async issueKey(userId: string, label: string, profile: string): Promise<string> {
    const token = `ok_${newToken(24)}`;
    await this.store.storeApiKey(sha256Hex(token), userId, label, profile);
    return token;
  }

  requireAdmin(identity: AuthIdentity | undefined): void {
    if (!identity?.admin) throw new AuthError('admin key required');
  }
}
