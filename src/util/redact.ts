/**
 * Redact secrets before anything reaches the output channel / logs. Masks IronBee
 * collector tokens (`ibt_…`), bearer/basic auth, JWTs, and the values of sensitive keys
 * in JSON (`"k":"v"`), kv/env/CLI-flag (`k=v`, `--k v`), YAML (`k: v`), and URL query
 * (`?k=v`) forms — quoted or not.
 */
const SECRET_KEYS: string =
    'oauthtoken|apikey|api_key|access_token|refresh_token|id_token|code_verifier|code|token|password|passwd|secret|client_secret';

const PATTERNS: Array<[RegExp, string]> = [
    // ibt_<base64url> collector tokens
    [/ibt_[A-Za-z0-9_-]{8,}/g, 'ibt_***'],
    // Authorization: Bearer / Basic <token>
    [/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
    // "key":"value" or "key": "value" (quoted JSON)
    [new RegExp(`("?(?:${SECRET_KEYS})"?\\s*:\\s*)"[^"]{3,}"`, 'gi'), '$1"***"'],
    // key=value / key: value / --key value (unquoted, incl. single-quoted values)
    [new RegExp(`\\b(${SECRET_KEYS})(\\s*[:=]\\s*|\\s+)(['"]?)[^\\s'"&,}]{3,}\\3`, 'gi'), '$1$2$3***$3'],
    // URL query: ?key=value / &key=value
    [new RegExp(`([?&](?:${SECRET_KEYS})=)[^&\\s"']{3,}`, 'gi'), '$1***'],
    // Long JWTs (three base64url segments)
    [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, 'eyJ***'],
];

export function redact(input: string): string {
    let out: string = input;
    for (const [re, repl] of PATTERNS) {
        out = out.replace(re, repl);
    }
    return out;
}
