export function githubRepository(origin: string): string | null {
  const scp = /^(?:[^@/:]+@)?github\.com:(.+)$/i.exec(origin);
  let path = scp?.[1];
  if (path === undefined) {
    try {
      const url = new URL(origin);
      const host = url.hostname.toLowerCase();
      if (host !== "github.com" && !(url.protocol === "ssh:" && host === "ssh.github.com"))
        return null;
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  const name = path.replace(/\/$/, "").replace(/\.git$/i, "");
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? `https://github.com/${name}` : null;
}
