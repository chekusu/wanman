const SSH_GITHUB_REPO_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;

function hasValidRepoPathname(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return false;
  return segments.every((segment, index) => {
    const normalized = index === 1 ? segment.replace(/\.git$/i, '') : segment;
    return normalized.length > 0 && !normalized.startsWith('.');
  });
}

export function isGitHubRepoUrl(repoUrl: string): boolean {
  const trimmed = repoUrl.trim();
  if (!trimmed) return false;

  if (SSH_GITHUB_REPO_RE.test(trimmed)) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  if (parsed.username && parsed.username !== 'git') return false;
  if (parsed.password || parsed.search || parsed.hash) return false;

  return hasValidRepoPathname(parsed.pathname);
}
