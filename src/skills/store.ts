import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SkillMeta, SkillsPort } from '../contracts/index.js';
import { truncateText } from '../core/util.js';

export interface SkillsConfig {
  dir?: string;
  repo: string;
  ref: string;
  tokenEnv: string;
  cacheDir: string;
  syncOnBoot: boolean;
  maxFileBytes: number;
}

/**
 * SkillsPort — the skills repo is content, not code (§8).
 * v1 sources: local dir override (dev) → GitHub raw fetch → disk cache.
 * Runtime never blocks on sync: loop uses cache/last-known set.
 */
export class SkillsStore implements SkillsPort {
  private files = new Map<string, string>(); // relPath → content
  private manifest: SkillMeta[] = [];
  private manifestTextCache = '';
  private readyFlag = false;

  constructor(private readonly cfg: SkillsConfig) {}

  ready(): boolean {
    return this.readyFlag;
  }

  async sync(force = false): Promise<{ files: number; source: string }> {
    if (this.cfg.dir && existsSync(this.cfg.dir)) {
      const n = this.loadFromDir(this.cfg.dir);
      return { files: n, source: `dir:${this.cfg.dir}` };
    }
    if (!force && this.files.size > 0) return { files: this.files.size, source: 'cache-memory' };
    if (!force && this.loadFromCache()) return { files: this.files.size, source: 'cache-disk' };

    try {
      const synced = await this.syncFromGithub();
      this.saveCache();
      return { files: synced, source: `github:${this.cfg.repo}@${this.cfg.ref}` };
    } catch (err) {
      if (this.files.size > 0) return { files: this.files.size, source: 'stale-memory' };
      throw new Error(`skills sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async list(): Promise<SkillMeta[]> {
    return this.manifest;
  }

  /** Condensed manifest for the system prompt (~≤2.5 KB). */
  async manifestText(): Promise<string> {
    if (this.manifestTextCache) return this.manifestTextCache;
    const lines = this.manifest
      .slice(0, 64)
      .map((s) => `- ${s.id} [${s.priority}] (${s.path}): ${truncateText(s.purpose, 200).text}${s.triggers.length ? ` triggers: ${s.triggers.slice(0, 6).join(', ')}` : ''}`);
    this.manifestTextCache = [
      'Available skills (load minimum sufficient set; read full SKILL.md via orch.skills_read before non-trivial work):',
      ...lines,
      'P0 core skills: Repo Analysis, Planning, Coding, Self Review, Completion Verification — load for any engineering task.',
      'Verification is mandatory: never report "done" without running the verification the skill requires.',
    ].join('\n');
    return this.manifestTextCache;
  }

  async read(relPath: string): Promise<string | null> {
    const norm = path.posix.normalize(relPath).replace(/^\/+/, '');
    if (norm.includes('..')) return null;
    return this.files.get(norm) ?? null;
  }

  /* ---------------- internals ---------------- */

  private loadFromDir(root: string): number {
    this.files.clear();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.md') && statSync(full).size <= this.cfg.maxFileBytes) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          this.files.set(rel, readFileSync(full, 'utf8'));
        }
      }
    };
    walk(root);
    this.rebuildManifest();
    this.readyFlag = this.files.size > 0;
    return this.files.size;
  }

  private async syncFromGithub(): Promise<number> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'agent-orchestrator/0.1' };
    const tok = process.env[this.cfg.tokenEnv];
    if (tok) headers.authorization = `Bearer ${tok}`;

    const treeRes = await fetch(`https://api.github.com/repos/${this.cfg.repo}/git/trees/${encodeURIComponent(this.cfg.ref)}?recursive=1`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!treeRes.ok) throw new Error(`trees API HTTP ${treeRes.status}`);
    const tree = (await treeRes.json()) as { tree?: { path: string; type: string; size?: number }[] };
    const mdFiles = (tree.tree ?? []).filter((t) => t.type === 'blob' && t.path.endsWith('.md') && (t.size ?? 0) <= this.cfg.maxFileBytes);

    const rawBase = `https://raw.githubusercontent.com/${this.cfg.repo}/${encodeURIComponent(this.cfg.ref)}`;
    this.files.clear();
    for (const f of mdFiles) {
      try {
        const r = await fetch(`${rawBase}/${f.path}`, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) this.files.set(f.path, await r.text());
      } catch {
        /* partial sync is fine; missing file = missing skill */
      }
    }
    this.rebuildManifest();
    this.readyFlag = this.files.size > 0;
    return this.files.size;
  }

  private rebuildManifest(): void {
    const metas: SkillMeta[] = [];
    for (const [rel, text] of this.files) {
      if (!rel.endsWith('SKILL.md')) continue;
      const dir = path.posix.dirname(rel);
      const category = dir.split('/')[0] ?? 'misc';
      const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? path.posix.basename(dir)).trim();
      const purpose =
        text
          .match(/##\s*Purpose\s*\n+([\s\S]*?)(?=\n##|\n---)/)?.[1]
          ?.split('\n')
          .map((l) => l.trim())
          .join(' ')
          .slice(0, 220) ?? title;
      const triggers =
        text
          .match(/##\s*(?:When to Use|Triggers)[\s\S]*?```(?:text)?\n([\s\S]*?)```/)?.[1]
          ?.split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10) ?? [];
      const priority = /^#\s*P([0-3])\b/m.exec(text)?.[0] ? `P${/^#\s*P([0-3])\b/m.exec(text)![1]}` : category === 'core' ? 'P0/P1' : 'P2';
      metas.push({ id: path.posix.basename(dir), path: rel, category, title, purpose, priority, triggers });
    }
    metas.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    this.manifest = metas;
    this.manifestTextCache = '';
  }

  private saveCache(): void {
    try {
      for (const [rel, content] of this.files) {
        const full = path.join(this.cfg.cacheDir, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
      }
    } catch {
      /* cache write is best-effort */
    }
  }

  private loadFromCache(): boolean {
    if (!existsSync(this.cfg.cacheDir)) return false;
    return this.loadFromDir(this.cfg.cacheDir) > 0;
  }
}
