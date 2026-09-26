// Shell program path → host tab title. The host names workbench tabs after
// the iframe `document.title`, so a local-terminal tab can present itself as
// the shell it runs (zsh, pwsh, …) instead of the static "Terminal".
// Mirrors the sidecar's `shell_basename`: split on both separators, drop a
// trailing `.exe`; case is kept so custom shell names stay recognizable.

export function shellTabTitle(program: string): string {
  const name = program.split(/[\\/]/).pop() || program;
  return name.replace(/\.exe$/i, "") || program;
}
