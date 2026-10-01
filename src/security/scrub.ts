/**
 * Secret scrubbing — applied to every tool result and error string before it
 * enters the model transcript (§9-6). Two mechanisms:
 *  1. literal replacement of every configured secret value (strongest)
 *  2. pattern redaction of common token shapes + URL passwords
 */
const PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_\-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_\-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi,
];

export function makeScrubber(secretValues: string[]): (text: string) => string {
  const literals = [...new Set(secretValues)].filter((s) => s && s.length >= 8);
  return function scrub(text: string): string {
    let out = text;
    for (const lit of literals) {
      if (out.includes(lit)) out = out.split(lit).join('[REDACTED:secret]');
    }
    for (const rx of PATTERNS) {
      out = out.replace(rx, (m) => {
        if (m.toLowerCase().startsWith('bearer ')) return 'Bearer [REDACTED]';
        if (m.includes('://')) return m.replace(/:[^:@/]+@/, ':[REDACTED]@');
        return '[REDACTED]';
      });
    }
    return out;
  };
}
