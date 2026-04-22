export interface ThreadSyncSpec {
  threadId: string
  syncUrl?: string
  syncSecret?: string
}

export interface ProjectRunSpec<THooks = unknown> {
  projectDir?: string
  repoSourceDir?: string
  repoCloneUrl?: string
  workspaceRoot?: string
  gitRoot?: string
  sourceLabel?: string
  bootstrapScript?: string
  githubToken?: string
  threadSync?: ThreadSyncSpec
  hooks?: THooks
}
