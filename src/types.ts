export type Level = 'error' | 'warning' | 'info' | 'ok';

export type Finding = {
  level: Level;
  /** Repo-relative file the finding is about. */
  file: string;
  /** 1-based line, best effort. */
  line?: number;
  /** Stable machine-readable code, e.g. `self-hosted-runner`. */
  code: string;
  message: string;
};
