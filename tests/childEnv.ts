// The environment tests give the git and npm they start: the shell's, without what would steer those children
// somewhere else. A shell's GIT_DIR or GIT_INDEX_FILE (a git hook, another tool) would point git at another repository,
// and `npm test` sets npm_config_* and npm_package_* variables that would reach a nested npm install.
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|npm_)/i.test(k)) env[k] = v
  return { ...env, ...extra }
}
