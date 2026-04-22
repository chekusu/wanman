import { describe, expect, it } from 'vitest';
import { isGitHubRepoUrl } from './github-repo-url.js';

describe('isGitHubRepoUrl', () => {
  it('accepts canonical GitHub repository URLs', () => {
    expect(isGitHubRepoUrl('https://github.com/acme/repo')).toBe(true);
    expect(isGitHubRepoUrl('https://github.com/acme/repo.git')).toBe(true);
    expect(isGitHubRepoUrl('git@github.com:acme/repo.git')).toBe(true);
    expect(isGitHubRepoUrl('ssh://git@github.com/acme/repo.git')).toBe(true);
  });

  it('rejects lookalike or malformed URLs', () => {
    expect(isGitHubRepoUrl('https://example.com/github.com/acme/repo')).toBe(false);
    expect(isGitHubRepoUrl('https://github.com/acme/repo/issues')).toBe(false);
    expect(isGitHubRepoUrl('https://github.com/acme/repo?ref=main')).toBe(false);
    expect(isGitHubRepoUrl('https://gitlab.com/acme/repo')).toBe(false);
    expect(isGitHubRepoUrl('')).toBe(false);
  });
});
